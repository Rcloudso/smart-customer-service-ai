import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { LLMMessage, ChatCompletionOptions, EmbeddingResult } from '../types/ai';

export interface LLMClient {
  chat(messages: LLMMessage[], options?: ChatCompletionOptions): Promise<string>;
  chatStream(
    messages: LLMMessage[],
    onToken: (token: string) => void,
    options?: ChatCompletionOptions,
  ): Promise<string>;
  embed(texts: string[]): Promise<EmbeddingResult[]>;
}

export interface RetryOptions {
  maxRetries?: number;
  timeoutMs?: number;
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (params: { attempt: number; maxRetries: number; delay: number; error: Error }) => void;
}

export async function runWithRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('LLM request timed out'));
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      lastError = timedOut
        ? new Error('LLM request timed out')
        : error instanceof Error ? error : new Error(String(error));
      const canRetry = attempt < maxRetries - 1
        && (options.shouldRetry?.(lastError) ?? true);
      if (!canRetry) break;
      const delay = Math.pow(2, attempt) * 1000;
      options.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delay,
        error: lastError,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('LLM request failed after retries');
}

class OpenAIClientImpl implements LLMClient {
  private chatClient: OpenAI;
  private embedClient: OpenAI;
  private configHash: string = '';

  constructor() {
    this.chatClient = this.buildChatClient();
    this.embedClient = this.buildEmbedClient();
    this.configHash = this.computeHash();
  }

  /**
   * Build (or rebuild) the chat OpenAI instance from current config.
   */
  private buildChatClient(): OpenAI {
    return new OpenAI({
      apiKey: config.llm.apiKey || undefined,
      baseURL: config.llm.apiBase || undefined,
    });
  }

  /**
   * Build (or rebuild) the embed OpenAI instance from current config.
   * Key priority: config.embed.apiKey → fallback config.llm.apiKey.
   */
  private buildEmbedClient(): OpenAI {
    const apiKey = config.embed.apiKey || config.llm.apiKey || undefined;
    const baseURL = config.embed.apiBase || undefined;
    return new OpenAI({
      apiKey,
      baseURL,
    });
  }

  /**
   * Compute a hash of all config values that affect client construction.
   * Uses full apiKey to avoid hash collisions when only the last 6 chars match.
   */
  private computeHash(): string {
    return [
      config.llm.apiBase,
      config.llm.apiKey || '',
      config.llm.model,
      config.embed.apiBase,
      config.embed.apiKey || '',
      config.embed.model,
    ].join('|');
  }

  /**
   * Ensure the internal clients are fresh by comparing config hash.
   * If any environment-backed config value changed, rebuild the affected client(s).
   */
  private ensureFresh(): void {
    const newHash = this.computeHash();
    if (newHash !== this.configHash) {
      logger.info('LLM config changed, rebuilding clients');
      this.chatClient = this.buildChatClient();
      this.embedClient = this.buildEmbedClient();
      this.configHash = newHash;
    }
  }

  async chat(messages: LLMMessage[], options?: ChatCompletionOptions): Promise<string> {
    this.ensureFresh();
    return this.withRetry(async (signal) => {
      const responseFormat = options?.responseFormat === 'json_schema' && options.responseSchema
        ? { type: 'json_schema' as const, json_schema: options.responseSchema }
        : options?.responseFormat === 'json_object'
          ? { type: 'json_object' as const }
          : undefined;
      const response = await this.chatClient.chat.completions.create(
        {
          model: options?.model ?? config.llm.model,
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 2000,
          response_format: responseFormat,
        },
        { signal },
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }
      return content;
    }, options?.maxRetries);
  }

  async chatStream(
    messages: LLMMessage[],
    onToken: (token: string) => void,
    options?: ChatCompletionOptions,
  ): Promise<string> {
    this.ensureFresh();
    let emittedToken = false;
    return this.withRetry(async (signal) => {
      const stream = await this.chatClient.chat.completions.create(
        {
          model: options?.model ?? config.llm.model,
          messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 2000,
          stream: true,
        },
        { signal },
      );

      let fullContent = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          emittedToken = true;
          fullContent += delta;
          onToken(delta);
        }
      }

      return fullContent;
    }, options?.maxRetries, () => !emittedToken);
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    this.ensureFresh();
    return this.withRetry(async (signal) => {
      const response = await this.embedClient.embeddings.create(
        {
          model: config.embed.model,
          input: texts,
        },
        { signal },
      );

      return response.data.map((item) => ({
        embedding: item.embedding,
        tokens: 0, // OpenAI doesn't return token count per item in embeddings response
      }));
    });
  }

  private withRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    maxRetries: number = 3,
    shouldRetry?: (error: Error) => boolean,
  ): Promise<T> {
    return runWithRetry(operation, {
      maxRetries,
      shouldRetry,
      onRetry: ({ attempt, maxRetries: attempts, delay, error }) => {
        logger.warn(
          { attempt, maxRetries: attempts, delay, err: error.message },
          'LLM request failed, retrying',
        );
      },
    });
  }
}

class LocalFallbackClientImpl implements LLMClient {
  async chat(messages: LLMMessage[]): Promise<string> {
    return this.buildResponse(messages);
  }

  async chatStream(
    messages: LLMMessage[],
    onToken: (token: string) => void,
  ): Promise<string> {
    const content = this.buildResponse(messages);
    for (let i = 0; i < content.length; i += 24) {
      onToken(content.slice(i, i + 24));
    }
    return content;
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      embedding: this.hashEmbedding(text),
      tokens: Math.ceil(text.length / 4),
    }));
  }

  private buildResponse(messages: LLMMessage[]): string {
    const systemPrompt = messages.find((message) => message.role === 'system')?.content ?? '';
    const documentExcerpt = this.extractFirstDocumentExcerpt(systemPrompt);
    if (documentExcerpt) {
      return `来自文档《${documentExcerpt.title}》的原文片段：\n${documentExcerpt.content}`;
    }
    const faqAnswer = this.extractFirstFaqAnswer(systemPrompt);
    if (faqAnswer) {
      return faqAnswer;
    }

    return '当前未配置 LLM API Key，已启用本地演示模式。请先在 FAQ 知识库中添加匹配条目，或在模型配置中填写可用的 OpenAI 兼容 API。';
  }

  private extractFirstFaqAnswer(systemPrompt: string): string | null {
    const match = systemPrompt.match(/【FAQ \d+】[\s\S]*?内容：<knowledge>([\s\S]*?)<\/knowledge>\n相关度：/);
    const answer = match?.[1]?.trim();
    return answer || null;
  }

  private extractFirstDocumentExcerpt(systemPrompt: string): { title: string; content: string } | null {
    const match = systemPrompt.match(/【DOCUMENT \d+】\n文档：([^\n]+)(?:\n页码：[^\n]+)?\n原文：<knowledge>([\s\S]*?)<\/knowledge>\n相关度：/);
    const title = match?.[1]?.trim();
    const content = match?.[2]?.trim();
    return title && content ? { title, content } : null;
  }

  private hashEmbedding(text: string): number[] {
    const dimensions = 64;
    const vector = new Array<number>(dimensions).fill(0);
    const normalized = text.trim().toLowerCase();

    if (!normalized) {
      return vector;
    }

    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      vector[code % dimensions] += 1;
      vector[(code * 31 + i) % dimensions] += 0.5;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) {
      return vector;
    }

    return vector.map((value) => value / norm);
  }
}

let llmClientInstance: LLMClient | null = null;
let llmClientMode: 'openai' | 'local' | null = null;

function resolveClientMode(): 'openai' | 'local' {
  return config.llm.apiKey ? 'openai' : 'local';
}

export function getLLMClient(): LLMClient {
  const mode = resolveClientMode();
  if (!llmClientInstance || llmClientMode !== mode) {
    llmClientInstance = mode === 'openai'
      ? new OpenAIClientImpl()
      : new LocalFallbackClientImpl();
    llmClientMode = mode;
    logger.info(
      { provider: mode === 'openai' ? config.llm.provider : 'local', model: config.llm.model },
      'LLM client initialized',
    );
  }
  return llmClientInstance;
}
