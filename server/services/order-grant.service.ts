import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { OrderAccessGrantRepo } from '../db/repos/order-access-grant.repo';
import {
  ORDER_STATUS_TOOL_NAME,
  ORDER_STATUS_TOOL_VERSION,
} from '../types/order-tool';
import { maskOrderReference, normalizeOrderReference } from '../tools/order-status';

interface OrderGrantServiceOptions {
  secret: string;
  ttlMs: number;
}

interface GrantBinding {
  sessionId: string;
  userIdent: string;
}

interface IssueGrantInput extends GrantBinding {
  orderReference: string;
}

export interface IssuedOrderGrant {
  token: string;
  maskedOrderReference: string;
  expiresAt: string;
  toolName: typeof ORDER_STATUS_TOOL_NAME;
  toolVersion: typeof ORDER_STATUS_TOOL_VERSION;
}

export interface ResolvedOrderGrant extends Omit<IssuedOrderGrant, 'token'> {
  id: string;
  sessionId: string;
  orderReference: string;
  orderReferenceFingerprint: string;
}

export class OrderGrantService {
  private readonly encryptionKey: Buffer;
  private readonly fingerprintKey: Buffer;

  constructor(
    private readonly repo: OrderAccessGrantRepo,
    private readonly options: OrderGrantServiceOptions,
  ) {
    if (options.secret.length < 8) throw new Error('order_grant_secret_too_short');
    if (options.ttlMs <= 0) throw new Error('order_grant_ttl_invalid');
    this.encryptionKey = Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(options.secret),
      Buffer.from('resolveweave-order-tools-v1'),
      Buffer.from('order-reference-encryption'),
      32,
    ));
    this.fingerprintKey = Buffer.from(hkdfSync(
      'sha256',
      Buffer.from(options.secret),
      Buffer.from('resolveweave-order-tools-v1'),
      Buffer.from('privacy-safe-fingerprints'),
      32,
    ));
  }

  issue(input: IssueGrantInput, now = new Date()): IssuedOrderGrant {
    const orderReference = normalizeOrderReference(input.orderReference);
    const token = randomBytes(32).toString('base64url');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(orderReference, 'utf8'),
      cipher.final(),
    ]);
    const expiresAt = new Date(now.getTime() + this.options.ttlMs).toISOString();

    this.repo.replaceForSession({
      id: randomUUID(),
      tokenHash: this.hashToken(token),
      sessionId: input.sessionId,
      userIdentHash: this.fingerprint(input.userIdent),
      encryptedOrderReference: encrypted.toString('base64url'),
      encryptionIv: iv.toString('base64url'),
      encryptionTag: cipher.getAuthTag().toString('base64url'),
      orderReferenceFingerprint: this.fingerprint(orderReference),
      maskedOrderReference: maskOrderReference(orderReference),
      toolName: ORDER_STATUS_TOOL_NAME,
      toolVersion: ORDER_STATUS_TOOL_VERSION,
      expiresAt,
      revokedAt: null,
      createdAt: now.toISOString(),
      lastUsedAt: null,
    });

    return {
      token,
      maskedOrderReference: maskOrderReference(orderReference),
      expiresAt,
      toolName: ORDER_STATUS_TOOL_NAME,
      toolVersion: ORDER_STATUS_TOOL_VERSION,
    };
  }

  resolve(token: string, binding: GrantBinding, now = new Date()): ResolvedOrderGrant | null {
    if (!token) return null;
    const grant = this.repo.findActiveByTokenHash(this.hashToken(token), now.toISOString());
    if (!grant || grant.sessionId !== binding.sessionId) return null;
    if (!this.safeEqual(grant.userIdentHash, this.fingerprint(binding.userIdent))) return null;
    if (grant.toolName !== ORDER_STATUS_TOOL_NAME || grant.toolVersion !== ORDER_STATUS_TOOL_VERSION) {
      return null;
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(grant.encryptionIv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(grant.encryptionTag, 'base64url'));
      const orderReference = Buffer.concat([
        decipher.update(Buffer.from(grant.encryptedOrderReference, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      this.repo.touch(grant.id, now.toISOString());
      return {
        id: grant.id,
        sessionId: grant.sessionId,
        orderReference,
        orderReferenceFingerprint: grant.orderReferenceFingerprint,
        maskedOrderReference: grant.maskedOrderReference,
        expiresAt: grant.expiresAt,
        toolName: grant.toolName,
        toolVersion: grant.toolVersion,
      };
    } catch {
      return null;
    }
  }

  revokeSession(sessionId: string, now = new Date()): number {
    return this.repo.revokeSession(sessionId, now.toISOString());
  }

  cleanupExpired(now = new Date()): number {
    return this.repo.deleteExpired(now.toISOString());
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private fingerprint(value: string): string {
    return createHmac('sha256', this.fingerprintKey).update(value).digest('hex');
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
