import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { getDatabase } from '../db';
import {
  BeginIdempotencyResult,
  IdempotencyRepo,
} from '../db/repos/idempotency.repo';

const RETENTION_MS = 24 * 60 * 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
}

export class IdempotencyService {
  private readonly repo: IdempotencyRepo;

  constructor(
    db: Database.Database = getDatabase(),
    private readonly now: () => number = Date.now,
  ) {
    this.repo = new IdempotencyRepo(db);
  }

  fingerprint(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(canonicalize(body ?? null)))
      .digest('hex');
  }

  begin(scope: string, key: string, requestHash: string): BeginIdempotencyResult {
    const now = this.now();
    return this.repo.begin(
      scope,
      key,
      requestHash,
      now,
      now - RETENTION_MS,
    );
  }

  complete(
    scope: string,
    key: string,
    requestHash: string,
    statusCode: number,
    contentType: string | null,
    responseBody: Buffer,
  ): void {
    this.repo.complete(
      scope,
      key,
      requestHash,
      statusCode,
      contentType,
      responseBody,
      this.now(),
    );
  }

}

let service: IdempotencyService | null = null;

export function getIdempotencyService(): IdempotencyService {
  if (!service) service = new IdempotencyService();
  return service;
}
