import Database from 'better-sqlite3';
import type { OrderAccessGrant } from '../../types/order-tool';

interface GrantRow {
  id: string;
  session_id: string;
  user_ident_hash: string;
  order_reference_ciphertext: string;
  order_reference_iv: string;
  order_reference_tag: string;
  order_reference_fingerprint: string;
  masked_order_reference: string;
  tool_name: OrderAccessGrant['toolName'];
  tool_version: OrderAccessGrant['toolVersion'];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}
export interface CreateOrderAccessGrantInput extends OrderAccessGrant {
  tokenHash: string;
}

export class OrderAccessGrantRepo {
  private readonly replaceForSessionTransaction: (input: CreateOrderAccessGrantInput) => void;

  constructor(private readonly db: Database.Database) {
    this.replaceForSessionTransaction = db.transaction((input: CreateOrderAccessGrantInput) => {
      this.db.prepare(
        `UPDATE order_access_grants
         SET revoked_at = ?
         WHERE session_id = ? AND revoked_at IS NULL`,
      ).run(input.createdAt, input.sessionId);
      this.db.prepare(
        `INSERT INTO order_access_grants (
           id, token_hash, session_id, user_ident_hash,
           order_reference_ciphertext, order_reference_iv, order_reference_tag,
           order_reference_fingerprint, masked_order_reference, tool_name,
           tool_version, expires_at, revoked_at, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.tokenHash,
        input.sessionId,
        input.userIdentHash,
        input.encryptedOrderReference,
        input.encryptionIv,
        input.encryptionTag,
        input.orderReferenceFingerprint,
        input.maskedOrderReference,
        input.toolName,
        input.toolVersion,
        input.expiresAt,
        input.revokedAt,
        input.createdAt,
        input.lastUsedAt,
      );
    });
  }

  replaceForSession(input: CreateOrderAccessGrantInput): void {
    this.replaceForSessionTransaction(input);
  }

  findActiveByTokenHash(tokenHash: string, now: string): OrderAccessGrant | null {
    const row = this.db.prepare(
      `SELECT * FROM order_access_grants
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).get(tokenHash, now) as GrantRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  touch(id: string, usedAt: string): void {
    this.db.prepare(
      'UPDATE order_access_grants SET last_used_at = ? WHERE id = ?',
    ).run(usedAt, id);
  }

  revokeSession(sessionId: string, revokedAt: string): number {
    return this.db.prepare(
      `UPDATE order_access_grants SET revoked_at = ?
       WHERE session_id = ? AND revoked_at IS NULL`,
    ).run(revokedAt, sessionId).changes;
  }

  deleteExpired(now: string): number {
    return this.db.prepare(
      'DELETE FROM order_access_grants WHERE expires_at <= ?',
    ).run(now).changes;
  }

  private mapRow(row: GrantRow): OrderAccessGrant {
    return {
      id: row.id,
      sessionId: row.session_id,
      userIdentHash: row.user_ident_hash,
      encryptedOrderReference: row.order_reference_ciphertext,
      encryptionIv: row.order_reference_iv,
      encryptionTag: row.order_reference_tag,
      orderReferenceFingerprint: row.order_reference_fingerprint,
      maskedOrderReference: row.masked_order_reference,
      toolName: row.tool_name,
      toolVersion: row.tool_version,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }
}
