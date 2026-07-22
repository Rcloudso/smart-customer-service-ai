import Database from 'better-sqlite3';

export interface CompletedIdempotencyRecord {
  requestHash: string;
  statusCode: number;
  contentType: string | null;
  responseBody: Buffer;
}

export type BeginIdempotencyResult =
  | { status: 'started' }
  | { status: 'processing' }
  | { status: 'mismatch' }
  | { status: 'completed'; record: CompletedIdempotencyRecord };

interface IdempotencyRow {
  request_hash: string;
  state: 'processing' | 'completed';
  status_code: number | null;
  content_type: string | null;
  response_body: Buffer | null;
}

export class IdempotencyRepo {
  private readonly beginTransaction: (
    scope: string,
    key: string,
    requestHash: string,
    now: number,
    expiry: number,
  ) => BeginIdempotencyResult;

  constructor(private readonly db: Database.Database) {
    this.beginTransaction = db.transaction((
      scope: string,
      key: string,
      requestHash: string,
      now: number,
      expiry: number,
    ): BeginIdempotencyResult => {
      this.db.prepare(
        'DELETE FROM idempotency_records WHERE updated_at < ?',
      ).run(expiry);

      const existing = this.db.prepare(
        `SELECT request_hash, state, status_code, content_type, response_body
         FROM idempotency_records
         WHERE scope = ? AND idempotency_key = ?`,
      ).get(scope, key) as IdempotencyRow | undefined;

      if (existing) {
        if (existing.request_hash !== requestHash) return { status: 'mismatch' };
        if (existing.state === 'processing') return { status: 'processing' };
        return {
          status: 'completed',
          record: {
            requestHash: existing.request_hash,
            statusCode: existing.status_code ?? 500,
            contentType: existing.content_type,
            responseBody: existing.response_body ?? Buffer.alloc(0),
          },
        };
      }

      this.db.prepare(
        `INSERT INTO idempotency_records (
           scope, idempotency_key, request_hash, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'processing', ?, ?)`,
      ).run(scope, key, requestHash, now, now);
      return { status: 'started' };
    });
  }

  begin(
    scope: string,
    key: string,
    requestHash: string,
    now: number,
    expiry: number,
  ): BeginIdempotencyResult {
    return this.beginTransaction(scope, key, requestHash, now, expiry);
  }

  complete(
    scope: string,
    key: string,
    requestHash: string,
    statusCode: number,
    contentType: string | null,
    responseBody: Buffer,
    now: number,
  ): void {
    this.db.prepare(
      `UPDATE idempotency_records
       SET state = 'completed',
           status_code = ?,
           content_type = ?,
           response_body = ?,
           updated_at = ?
       WHERE scope = ?
         AND idempotency_key = ?
         AND request_hash = ?
         AND state = 'processing'`,
    ).run(statusCode, contentType, responseBody, now, scope, key, requestHash);
  }

}
