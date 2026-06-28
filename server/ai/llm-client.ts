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
   * If any config value changed (e.g. via DB override), rebuild the affected client(s).
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
    return this.withRetry(async () => {
      const response = await this.chatClient.chat.completions.create({
        model: options?.model ?? config.llm.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2000,
        response_format: options?.responseFormat === 'json_object'
          ? { type: 'json_object' }
          : undefined,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }
      return content;
    });
  }

  async chatStream(
    messages: LLMMessage[],
    onToken: (token: string) => void,
    options?: ChatCompletionOptions,
  ): Promise<string> {
    this.ensureFresh();
    return this.withRetry(async () => {
      const stream = await this.chatClient.chat.completions.create({
        model: options?.model ?? config.llm.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2000,
        stream: true,
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          onToken(delta);
        }
      }

      return fullContent;
    });
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    this.ensureFresh();
    return this.withRetry(async () => {
      const response = await this.embedClient.embeddings.create({
        model: config.embed.model,
        input: texts,
      });

      return response.data.map((item) => ({
        embedding: item.embedding,
        tokens: 0, // OpenAI doesn't return token count per item in embeddings response
      }));
    });
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('LLM request timed out')), 30000);
        });
        return await Promise.race([fn(), timeoutPromise]);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(
          { attempt: attempt + 1, maxRetries, delay, err: lastError.message },
          'LLM request failed, retrying',
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('LLM request failed after retries');
  }
}

let llmClientInstance: LLMClient | null = null;

export function getLLMClient(): LLMClient {
  if (!llmClientInstance) {
    llmClientInstance = new OpenAIClientImpl();
    logger.info({ provider: config.llm.provider, model: config.llm.model }, 'LLM client initialized');
  }
  return llmClientInstance;
}
