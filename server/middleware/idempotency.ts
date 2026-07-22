import type { NextFunction, Request, Response } from 'express';
import { getIdempotencyService } from '../services/idempotency.service';
import { ConflictError, ValidationError } from '../utils/errors';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_REPLAY_BODY_BYTES = 10 * 1024 * 1024;

function captureChunk(
  chunks: Buffer[],
  chunk: unknown,
  capturedBytes: number,
  encoding?: BufferEncoding,
): number {
  if (chunk === undefined || chunk === null) return capturedBytes;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), encoding);
  const nextBytes = capturedBytes + buffer.length;
  if (nextBytes > MAX_REPLAY_BODY_BYTES) {
    chunks.length = 0;
    return -1;
  }
  chunks.push(buffer);
  return nextBytes;
}

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATION_METHODS.has(req.method) || req.is('multipart/form-data')) {
    next();
    return;
  }

  const key = req.get('Idempotency-Key');
  if (!key) {
    next();
    return;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    next(new ValidationError(
      'Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen',
    ));
    return;
  }

  const service = getIdempotencyService();
  const body = req.body as Record<string, unknown> | undefined;
  const actor = req.user?.id
    ?? (typeof body?.userIdent === 'string' && body.userIdent
      ? body.userIdent
      : req.ip || 'anonymous');
  const actorHash = service.fingerprint(actor);
  const scope = JSON.stringify([
    actorHash,
    req.method,
    req.originalUrl.split('?')[0],
  ]);
  const requestHash = service.fingerprint({ query: req.query, body: req.body });
  const begin = service.begin(scope, key, requestHash);

  if (begin.status === 'mismatch') {
    next(new ConflictError('Idempotency key was already used with a different request'));
    return;
  }
  if (begin.status === 'processing') {
    next(new ConflictError('A request with this idempotency key is still processing'));
    return;
  }
  if (begin.status === 'completed') {
    res.status(begin.record.statusCode);
    res.setHeader('Idempotency-Replayed', 'true');
    if (begin.record.contentType) {
      res.setHeader('Content-Type', begin.record.contentType);
    }
    res.end(begin.record.responseBody);
    return;
  }

  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let finalized = false;
  let replayable = true;
  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = (function (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  ) {
    const encoding = typeof encodingOrCallback === 'string'
      ? encodingOrCallback
      : undefined;
    if (replayable) {
      const nextBytes = captureChunk(chunks, chunk, capturedBytes, encoding);
      replayable = nextBytes >= 0;
      if (replayable) capturedBytes = nextBytes;
    }
    return Reflect.apply(originalWrite, res, Array.from(arguments));
  }) as typeof res.write;

  res.end = (function (
    chunkOrCallback?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
  ) {
    const chunk = typeof chunkOrCallback === 'function'
      ? undefined
      : chunkOrCallback;
    const encoding = typeof encodingOrCallback === 'string'
      ? encodingOrCallback
      : undefined;
    if (!finalized) {
      if (replayable) {
        const nextBytes = captureChunk(chunks, chunk, capturedBytes, encoding);
        replayable = nextBytes >= 0;
        if (replayable) capturedBytes = nextBytes;
      }
      finalized = true;
      if (replayable) {
        service.complete(
          scope,
          key,
          requestHash,
          res.statusCode,
          res.getHeader('Content-Type')?.toString() ?? null,
          Buffer.concat(chunks),
        );
      }
    }
    return Reflect.apply(originalEnd, res, Array.from(arguments));
  }) as typeof res.end;

  // Unfinished requests intentionally remain `processing` until retention
  // cleanup. Same-key retries fail closed rather than repeating an unknown
  // write after a disconnect or oversized response.
  next();
}
