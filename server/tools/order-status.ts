import {
  ORDER_STATUS_TOOL_NAME,
  ORDER_STATUS_TOOL_VERSION,
  OrderStatusAdapter,
  OrderStatusResult,
  orderStatusResultSchema,
} from '../types/order-tool';

export { ORDER_STATUS_TOOL_NAME, ORDER_STATUS_TOOL_VERSION };
export type { OrderStatusAdapter, OrderStatusResult };

interface DemoFixture {
  verificationCode: string;
  result: OrderStatusResult;
}
const DEMO_FIXTURES: Readonly<Record<string, DemoFixture>> = Object.freeze({
  'RW-DEMO-1001': {
    verificationCode: '246810',
    result: {
      orderReferenceMasked: 'RW-••••-1001',
      orderStatus: 'processing',
      shippingStatus: 'not_shipped',
      carrier: 'not_assigned',
      trackingNumberMasked: null,
      latestEvent: 'order_processing',
      latestEventAt: '2026-08-11T08:30:00.000Z',
      estimatedDeliveryDate: '2026-08-17',
      dataUpdatedAt: '2026-08-11T08:35:00.000Z',
    },
  },
  'RW-DEMO-1002': {
    verificationCode: '135790',
    result: {
      orderReferenceMasked: 'RW-••••-1002',
      orderStatus: 'shipped',
      shippingStatus: 'in_transit',
      carrier: 'demo_express',
      trackingNumberMasked: '••••••7890',
      latestEvent: 'departed_origin',
      latestEventAt: '2026-08-12T02:00:00.000Z',
      estimatedDeliveryDate: '2026-08-15',
      dataUpdatedAt: '2026-08-12T02:05:00.000Z',
    },
  },
  'RW-DEMO-1003': {
    verificationCode: '112233',
    result: {
      orderReferenceMasked: 'RW-••••-1003',
      orderStatus: 'delivered',
      shippingStatus: 'delivered',
      carrier: 'demo_express',
      trackingNumberMasked: '••••••8031',
      latestEvent: 'delivered',
      latestEventAt: '2026-08-10T09:20:00.000Z',
      estimatedDeliveryDate: '2026-08-10',
      dataUpdatedAt: '2026-08-10T09:25:00.000Z',
    },
  },
  'RW-DEMO-1004': {
    verificationCode: '445566',
    result: {
      orderReferenceMasked: 'RW-••••-1004',
      orderStatus: 'exception',
      shippingStatus: 'exception',
      carrier: 'demo_express',
      trackingNumberMasked: '••••••4420',
      latestEvent: 'delivery_exception',
      latestEventAt: '2026-08-12T04:40:00.000Z',
      estimatedDeliveryDate: null,
      dataUpdatedAt: '2026-08-12T04:45:00.000Z',
    },
  },
});

export function normalizeOrderReference(value: string): string {
  return value.trim().toUpperCase();
}

export function maskOrderReference(value: string): string {
  const normalized = normalizeOrderReference(value);
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}-••••-${parts.at(-1)!.slice(-4)}`;
  }
  if (normalized.length <= 4) return '••••';
  return `${normalized.slice(0, 2)}••••${normalized.slice(-2)}`;
}

export function validateOrderStatusResult(value: unknown): OrderStatusResult {
  return orderStatusResultSchema.parse(value);
}

export class DemoOrderStatusAdapter implements OrderStatusAdapter {
  readonly name = 'demo';
  readonly version = '1';

  async verify(orderReference: string, verificationCode: string): Promise<boolean> {
    const fixture = DEMO_FIXTURES[normalizeOrderReference(orderReference)];
    return fixture?.verificationCode === verificationCode;
  }

  async lookup(orderReference: string, deadline: number): Promise<unknown> {
    if (Date.now() >= deadline) {
      throw new Error('deadline_exceeded');
    }
    const fixture = DEMO_FIXTURES[normalizeOrderReference(orderReference)];
    if (!fixture) {
      throw new Error('order_not_found');
    }
    return structuredClone(fixture.result);
  }
}
