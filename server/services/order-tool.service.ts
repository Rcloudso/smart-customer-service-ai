import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from '../config';
import { getDatabase } from '../db';
import { MessageRepo } from '../db/repos/message.repo';
import { OrderAccessGrantRepo } from '../db/repos/order-access-grant.repo';
import { SessionRepo } from '../db/repos/session.repo';
import { ToolExecutionRepo } from '../db/repos/tool-execution.repo';
import { DemoOrderStatusAdapter, validateOrderStatusResult } from '../tools/order-status';
import type { OrderStatusAdapter, OrderStatusResult } from '../types/order-tool';
import { ORDER_STATUS_TOOL_NAME, ORDER_STATUS_TOOL_VERSION } from '../types/order-tool';
import { IntentCategory, MessageRole, SessionStatus } from '../types/domain';
import { AuthError, RateLimitError, ServiceUnavailableError } from '../utils/errors';
import { EscalationService } from './escalation.service';
import { OrderGrantService, ResolvedOrderGrant } from './order-grant.service';

interface OrderToolServiceOptions {
  adapter: OrderStatusAdapter | null;
  secret: string;
  timeoutMs: number;
  grantTtlMs: number;
  now?: () => Date;
  sessionVerifyLimit?: number;
  sessionVerifyWindowMs?: number;
}

export interface VerifyOrderInput {
  sessionId: string;
  userIdent: string;
  orderReference: string;
  verificationCode: string;
}

export interface OrderLookupResponse {
  executionId: string;
  messageId: string;
  result: OrderStatusResult;
  localizedText: { zh: string; en: string };
}

const SAFE_HISTORY_SUMMARY = '订单状态查询已完成，重新查看需再次验证。 / Order status lookup completed; reverify to view it again.';

export class OrderToolService {
  private readonly sessionRepo: SessionRepo;
  private readonly messageRepo: MessageRepo;
  private readonly executionRepo: ToolExecutionRepo;
  private readonly grantService: OrderGrantService;
  private readonly escalationService: EscalationService;
  private readonly now: () => Date;
  private readonly attempts = new Map<string, number[]>();
  private readonly sessionVerifyLimit: number;
  private readonly sessionVerifyWindowMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: OrderToolServiceOptions,
  ) {
    this.sessionRepo = new SessionRepo(db);
    this.messageRepo = new MessageRepo(db);
    this.executionRepo = new ToolExecutionRepo(db);
    this.grantService = new OrderGrantService(new OrderAccessGrantRepo(db), {
      secret: options.secret,
      ttlMs: options.grantTtlMs,
    });
    this.escalationService = new EscalationService(db, { enableModelExtraction: false });
    this.now = options.now ?? (() => new Date());
    this.sessionVerifyLimit = options.sessionVerifyLimit ?? 5;
    this.sessionVerifyWindowMs = options.sessionVerifyWindowMs ?? 10 * 60 * 1_000;
  }

  isEnabled(): boolean {
    return this.options.adapter !== null;
  }

  async verify(input: VerifyOrderInput): Promise<ReturnType<OrderGrantService['issue']>> {
    const adapter = this.requireAdapter();
    this.consumeVerificationAttempt(input.sessionId);
    const session = this.sessionRepo.findById(input.sessionId);
    if (
      !session
      || session.userIdent !== input.userIdent
      || session.origin !== 'customer'
      || session.status !== SessionStatus.ACTIVE
    ) {
      throw new AuthError('订单号或验证码无效');
    }

    let verified = false;
    try {
      verified = await adapter.verify(input.orderReference, input.verificationCode);
    } catch {
      throw new ServiceUnavailableError('订单验证服务暂时不可用，请稍后重试');
    }
    if (!verified) throw new AuthError('订单号或验证码无效');
    return this.grantService.issue(input, this.now());
  }

  resolveGrant(
    token: string,
    binding: { sessionId: string; userIdent: string },
  ): ResolvedOrderGrant | null {
    const session = this.sessionRepo.findById(binding.sessionId);
    if (
      !session
      || session.userIdent !== binding.userIdent
      || session.origin !== 'customer'
      || session.status !== SessionStatus.ACTIVE
    ) return null;
    return this.grantService.resolve(token, binding, this.now());
  }

  async lookup(grant: ResolvedOrderGrant, idempotencyKey: string): Promise<OrderLookupResponse> {
    const adapter = this.requireAdapter();
    const startedAt = this.now();
    const executionId = randomUUID();
    this.executionRepo.start({
      id: executionId,
      sessionId: grant.sessionId,
      userMessageId: null,
      idempotencyKey,
      toolName: ORDER_STATUS_TOOL_NAME,
      toolVersion: ORDER_STATUS_TOOL_VERSION,
      adapterName: adapter.name,
      adapterVersion: adapter.version,
      maskedOrderReference: grant.maskedOrderReference,
      orderReferenceFingerprint: grant.orderReferenceFingerprint,
      createdAt: startedAt.toISOString(),
    });

    try {
      const deadline = Date.now() + this.options.timeoutMs;
      const rawResult = await this.withTimeout(
        adapter.lookup(grant.orderReference, deadline),
        this.options.timeoutMs,
      );
      const result = validateOrderStatusResult(rawResult);
      if (result.orderReferenceMasked !== grant.maskedOrderReference) {
        throw new ZodError([]);
      }
      const completedAt = this.now();
      const assistantMessage = this.db.transaction(() => {
        const message = this.messageRepo.create({
          sessionId: grant.sessionId,
          role: MessageRole.ASSISTANT,
          content: SAFE_HISTORY_SUMMARY,
          intent: IntentCategory.ORDER,
          intentConf: 1,
          retrievalSnapshot: [],
        });
        this.sessionRepo.touch(grant.sessionId);
        this.executionRepo.succeed(executionId, {
          assistantMessageId: message.id,
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          resultSummary: {
            orderStatus: result.orderStatus,
            shippingStatus: result.shippingStatus,
            latestEvent: result.latestEvent,
          },
          completedAt: completedAt.toISOString(),
        });
        return message;
      })();
      return {
        executionId,
        messageId: assistantMessage.id,
        result,
        localizedText: formatOrderStatusResult(result),
      };
    } catch (error) {
      const completedAt = this.now();
      const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      if (error instanceof ZodError) {
        await this.failAndEscalateUnsafeResult(
          executionId,
          grant.sessionId,
          durationMs,
          completedAt,
        );
        throw new ServiceUnavailableError(
          'Order status result could not be verified; the request was transferred to support',
        );
      }
      const safeErrorCode = error instanceof OrderToolTimeoutError
        ? 'adapter_timeout'
        : 'adapter_unavailable';
      this.executionRepo.fail(executionId, safeErrorCode, durationMs, completedAt.toISOString());
      throw new ServiceUnavailableError(
        '订单查询服务暂时不可用，请重试或转人工 / Order lookup is unavailable; retry or contact support',
      );
    }
  }

  revokeSession(sessionId: string): number {
    return this.grantService.revokeSession(sessionId, this.now());
  }

  listExecutions(sessionId: string) {
    return this.executionRepo.listBySession(sessionId);
  }

  private requireAdapter(): OrderStatusAdapter {
    if (!this.options.adapter) {
      throw new ServiceUnavailableError('订单查询工具未启用');
    }
    return this.options.adapter;
  }

  private consumeVerificationAttempt(sessionId: string): void {
    const now = this.now().getTime();
    const recent = (this.attempts.get(sessionId) ?? [])
      .filter((timestamp) => timestamp > now - this.sessionVerifyWindowMs);
    if (recent.length >= this.sessionVerifyLimit) {
      throw new RateLimitError('订单验证尝试过多，请稍后重试');
    }
    recent.push(now);
    this.attempts.set(sessionId, recent);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new OrderToolTimeoutError()), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async failAndEscalateUnsafeResult(
    executionId: string,
    sessionId: string,
    durationMs: number,
    completedAt: Date,
  ): Promise<void> {
    const prepared = await this.escalationService.prepareEscalation({
      sessionId,
      reason: '订单查询工具返回无法验证的结果',
      intent: IntentCategory.ORDER,
      groundingStatus: 'high_risk',
      messages: this.messageRepo.findBySession(sessionId),
      retrievalSnapshot: [],
    });
    prepared.packet = {
      ...prepared.packet,
      category: 'order',
      priority: 'high',
      reasonCode: 'unsafe_tool_result',
      riskFlags: prepared.packet.riskFlags.includes('unsafe_tool_result')
        ? prepared.packet.riskFlags
        : [...prepared.packet.riskFlags, 'unsafe_tool_result'],
      recommendedQueue: 'order_support',
      suggestedNextStep: 'Review the order lookup safely without exposing provider data.',
      extractionMode: 'deterministic',
    };
    this.db.transaction(() => {
      this.executionRepo.fail(
        executionId,
        'unsafe_adapter_result',
        durationMs,
        completedAt.toISOString(),
      );
      this.escalationService.persistPreparedEscalation(prepared);
    })();
  }
}

class OrderToolTimeoutError extends Error {}

export function formatOrderStatusResult(result: OrderStatusResult): { zh: string; en: string } {
  const stateZh: Record<OrderStatusResult['shippingStatus'], string> = {
    not_shipped: '处理中，尚未发货',
    in_transit: '运输中',
    delivered: '已送达',
    exception: '物流异常',
  };
  const stateEn: Record<OrderStatusResult['shippingStatus'], string> = {
    not_shipped: 'Processing; not yet shipped',
    in_transit: 'In transit',
    delivered: 'Delivered',
    exception: 'Shipping exception',
  };
  return {
    zh: `订单 ${result.orderReferenceMasked}：${stateZh[result.shippingStatus]}。数据更新时间：${result.dataUpdatedAt}`,
    en: `Order ${result.orderReferenceMasked}: ${stateEn[result.shippingStatus]}. Data updated: ${result.dataUpdatedAt}`,
  };
}

let singleton: OrderToolService | null = null;

export function getOrderToolService(): OrderToolService {
  if (!singleton) {
    singleton = new OrderToolService(getDatabase(), {
      adapter: config.orderTool.provider === 'demo' ? new DemoOrderStatusAdapter() : null,
      secret: config.jwt.secret,
      timeoutMs: config.orderTool.timeoutMs,
      grantTtlMs: config.orderTool.grantTtlMs,
    });
  }
  return singleton;
}
