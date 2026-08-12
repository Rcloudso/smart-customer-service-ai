import { z } from 'zod';

export const ORDER_STATUS_TOOL_NAME = 'order_status_lookup' as const;
export const ORDER_STATUS_TOOL_VERSION = '1' as const;
const MASKED_ORDER_REFERENCE_PATTERN = /^[A-Z0-9]{1,12}-[•*]{4}-[A-Z0-9]{1,4}$/;
const MASKED_TRACKING_NUMBER_PATTERN = /^[•*]{4,16}[A-Z0-9]{2,4}$/;

export const orderStatusResultSchema = z.object({
  orderReferenceMasked: z.string().regex(MASKED_ORDER_REFERENCE_PATTERN),
  orderStatus: z.enum(['processing', 'shipped', 'delivered', 'exception']),
  shippingStatus: z.enum(['not_shipped', 'in_transit', 'delivered', 'exception']),
  carrier: z.enum(['not_assigned', 'demo_express']),
  trackingNumberMasked: z.string().regex(MASKED_TRACKING_NUMBER_PATTERN).nullable(),
  latestEvent: z.enum([
    'order_processing',
    'departed_origin',
    'delivered',
    'delivery_exception',
  ]),
  latestEventAt: z.string().datetime().nullable(),
  estimatedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dataUpdatedAt: z.string().datetime(),
}).strict();

export type OrderStatusResult = z.infer<typeof orderStatusResultSchema>;

export interface OrderStatusAdapter {
  readonly name: string;
  readonly version: string;
  verify(orderReference: string, verificationCode: string): Promise<boolean>;
  lookup(orderReference: string, deadline: number): Promise<unknown>;
}
export interface OrderAccessGrant {
  id: string;
  sessionId: string;
  userIdentHash: string;
  encryptedOrderReference: string;
  encryptionIv: string;
  encryptionTag: string;
  orderReferenceFingerprint: string;
  maskedOrderReference: string;
  toolName: typeof ORDER_STATUS_TOOL_NAME;
  toolVersion: typeof ORDER_STATUS_TOOL_VERSION;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type ToolExecutionStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface ToolExecution {
  id: string;
  sessionId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  idempotencyKey: string | null;
  toolName: typeof ORDER_STATUS_TOOL_NAME;
  toolVersion: typeof ORDER_STATUS_TOOL_VERSION;
  adapterName: string;
  adapterVersion: string;
  maskedOrderReference: string;
  orderReferenceFingerprint: string;
  status: ToolExecutionStatus;
  safeErrorCode: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
