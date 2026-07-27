import {
  MAX_OCR_EXTRACTION_RESULT_BYTES,
  OcrEngineName,
  OcrExtractionResult,
  validateOcrExtractionResult,
} from './ocr-contract';

const MAX_OCR_SOURCE_BYTES = 10 * 1024 * 1024;
const OCR_SOURCE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export interface OcrExtractionRequest {
  requestId: string;
  documentId: string;
  sourceVersion: number;
  fileName: string;
  mimeType: string;
  sha256: string;
  buffer: Buffer;
}

export interface OcrExtractor {
  readonly engine: OcrEngineName;
  readonly engineVersion: string;
  extract(request: OcrExtractionRequest): Promise<OcrExtractionResult>;
}

export interface HttpOcrExtractorOptions {
  baseUrl: string;
  token?: string;
  engine: OcrEngineName;
  engineVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpOcrExtractor implements OcrExtractor {
  readonly engine: OcrEngineName;
  readonly engineVersion: string;
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpOcrExtractorOptions) {
    this.endpoint = resolveEndpoint(options.baseUrl);
    this.engine = options.engine;
    this.engineVersion = options.engineVersion.trim();
    if (!this.engineVersion) throw new Error('OCR engine version is required');
    this.token = options.token?.trim() ?? '';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30 * 60 * 1_000) {
      throw new Error('OCR timeout must be between 1 second and 30 minutes');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async extract(request: OcrExtractionRequest): Promise<OcrExtractionResult> {
    validateExtractionRequest(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          contractVersion: 'ocr-worker-request-v1',
          requestId: request.requestId,
          documentId: request.documentId,
          sourceVersion: request.sourceVersion,
          source: {
            fileName: request.fileName,
            mimeType: request.mimeType,
            sha256: request.sha256,
            contentBase64: request.buffer.toString('base64'),
          },
          requestedEngine: {
            name: this.engine,
            version: this.engineVersion,
          },
        }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new OcrExtractionError('ocr_worker_rejected');
      const text = await readResponseTextBounded(response);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new OcrExtractionError('invalid_ocr_result');
      }
      const result = validateWorkerEnvelope(payload);
      if (
        result.engine.name !== this.engine
        || result.engine.version !== this.engineVersion
      ) {
        throw new OcrExtractionError('ocr_worker_engine_mismatch');
      }
      return result;
    } catch (error) {
      if (error instanceof OcrExtractionError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OcrExtractionError('ocr_worker_timeout');
      }
      throw new OcrExtractionError('ocr_worker_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('OCR service URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('OCR service URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('OCR service URL must not contain credentials');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/extractions`;
  url.search = '';
  url.hash = '';
  return url;
}

function validateExtractionRequest(request: OcrExtractionRequest): void {
  if (
    !request.requestId
    || request.requestId.length > 120
    || !/^[0-9a-f-]{36}$/i.test(request.documentId)
    || !Number.isInteger(request.sourceVersion)
    || request.sourceVersion < 1
    || !request.fileName
    || request.fileName.length > 255
    || !OCR_SOURCE_MIME_TYPES.has(request.mimeType)
    || !/^[a-f0-9]{64}$/.test(request.sha256)
    || request.buffer.byteLength < 1
    || request.buffer.byteLength > MAX_OCR_SOURCE_BYTES
  ) {
    throw new OcrExtractionError('invalid_ocr_request');
  }
}

async function readResponseTextBounded(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_OCR_EXTRACTION_RESULT_BYTES) {
    throw new OcrExtractionError('ocr_worker_response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OCR_EXTRACTION_RESULT_BYTES) {
      await reader.cancel();
      throw new OcrExtractionError('ocr_worker_response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function validateWorkerEnvelope(input: unknown): OcrExtractionResult {
  if (!input || typeof input !== 'object') {
    throw new OcrExtractionError('invalid_ocr_result');
  }
  const envelope = input as { code?: unknown; data?: unknown };
  if (envelope.code !== 0) throw new OcrExtractionError('ocr_worker_rejected');
  try {
    return validateOcrExtractionResult(envelope.data);
  } catch {
    throw new OcrExtractionError('invalid_ocr_result');
  }
}

export class OcrExtractionError extends Error {
  constructor(
    public readonly failureCode:
      | 'ocr_worker_unavailable'
      | 'ocr_worker_timeout'
      | 'ocr_worker_rejected'
      | 'ocr_worker_response_too_large'
      | 'ocr_worker_engine_mismatch'
      | 'invalid_ocr_request'
      | 'invalid_ocr_result',
  ) {
    super(failureCode);
  }
}
