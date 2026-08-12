import { maskOrderReference, normalizeOrderReference } from './order-status';

export type OrderToolRouteKind =
  | 'explicit_human'
  | 'write_action'
  | 'lookup'
  | 'policy_question'
  | 'not_applicable';

export interface OrderToolRoute {
  kind: OrderToolRouteKind;
  orderReference: string | null;
  maskedOrderReference: string | null;
  safeMessage: string;
}

const ORDER_REFERENCE_PATTERN = /\bRW-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/giu;
const EXPLICIT_HUMAN_PATTERN = /转人工|人工客服|找人工|找客服|人工服务|human (?:agent|support)|talk to (?:a )?(?:person|human)/iu;
const WRITE_ACTION_PATTERN = /取消订单|退款|退货|修改.{0,8}(?:收货)?地址|更改.{0,8}(?:收货)?地址|改址|cancel (?:my )?order|refund|return (?:my )?order|change (?:my )?(?:shipping )?address/iu;
const LOOKUP_PATTERN = /我的订单|订单状态|物流状态|物流进度|快递.{0,6}(?:哪|到)|查(?:询)?订单|查(?:询)?物流|track (?:my )?order|order status|shipping status|delivery status/iu;
const POLICY_PATTERN = /(?:如何|怎么|怎样|在哪里).{0,12}(?:查|查询|看|跟踪).{0,8}(?:物流|订单)|(?:物流|订单).{0,8}(?:查询方式|怎么查)|how (?:do|can) i (?:check|track)|where can i (?:check|track)/iu;

export function findOrderReference(message: string): string | null {
  const match = message.normalize('NFKC').match(ORDER_REFERENCE_PATTERN)?.[0];
  return match ? normalizeOrderReference(match) : null;
}

export function sanitizeOrderReferences(message: string): string {
  return message.normalize('NFKC').replace(
    ORDER_REFERENCE_PATTERN,
    (reference) => maskOrderReference(reference),
  );
}

export function planOrderToolRoute(message: string): OrderToolRoute {
  const normalized = message.normalize('NFKC').trim();
  const orderReference = findOrderReference(normalized);
  const maskedOrderReference = orderReference ? maskOrderReference(orderReference) : null;
  const safeMessage = sanitizeOrderReferences(normalized);

  if (EXPLICIT_HUMAN_PATTERN.test(normalized)) {
    return { kind: 'explicit_human', orderReference, maskedOrderReference, safeMessage };
  }
  if (WRITE_ACTION_PATTERN.test(normalized)) {
    return { kind: 'write_action', orderReference, maskedOrderReference, safeMessage };
  }
  if (orderReference || LOOKUP_PATTERN.test(normalized)) {
    if (!orderReference && POLICY_PATTERN.test(normalized)) {
      return { kind: 'policy_question', orderReference, maskedOrderReference, safeMessage };
    }
    return { kind: 'lookup', orderReference, maskedOrderReference, safeMessage };
  }
  if (POLICY_PATTERN.test(normalized)) {
    return { kind: 'policy_question', orderReference, maskedOrderReference, safeMessage };
  }
  return { kind: 'not_applicable', orderReference, maskedOrderReference, safeMessage };
}
