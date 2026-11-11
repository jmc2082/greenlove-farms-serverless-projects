import { FulfillmentGroup, FulfillmentGroupStatus, FulfillmentMethod, Order, OrderStatus } from '@greenlove/shared';

// The path each kind of group follows (Phase 1: STOCKED). Grow- and made-to-order steps arrive with Phase 2.
export const STATUS_FLOW: Record<FulfillmentMethod, FulfillmentGroupStatus[]> = {
  SHIP: ['PREPARING', 'SHIPPED', 'DELIVERED'],
  LOCAL_DELIVERY: ['SCHEDULED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'],
  PICKUP: ['SCHEDULED', 'PREPARING', 'READY', 'PICKED_UP'],
};

export const FINAL: FulfillmentGroupStatus[] = ['DELIVERED', 'PICKED_UP', 'CANCELLED'];

/**
 * Staff move a group forward along its path (skipping steps is fine) or cancel it before it's done.
 * Admins may also correct a mistake by moving it to any status on its path.
 */
export function checkTransition(g: FulfillmentGroup, to: FulfillmentGroupStatus, isAdmin: boolean): string | null {
  const flow = STATUS_FLOW[g.method];
  if (to === g.status) return `Already ${to}`;
  if (to === 'CANCELLED') return FINAL.includes(g.status) && !isAdmin ? `Can't cancel a group that is ${g.status}` : null;
  if (!flow.includes(to)) return `${to} isn't a step for ${g.method} (${flow.join(' → ')})`;
  if (isAdmin) return null;
  if (g.status === 'CANCELLED') return 'Only an admin can reopen a cancelled group';
  if (flow.indexOf(to) < flow.indexOf(g.status)) return `Can't move back from ${g.status} to ${to}; ask an admin`;
  return null;
}

// Order-level status from its groups, unless the whole payment was refunded.
export function orderStatusFor(o: Pick<Order, 'fulfillmentGroups' | 'payment'>): OrderStatus {
  if (o.payment.status === 'REFUNDED') return 'REFUNDED';
  const statuses = o.fulfillmentGroups.map((g) => g.status);
  if (statuses.every((s) => s === 'CANCELLED')) return 'CANCELLED';
  if (statuses.every((s) => FINAL.includes(s))) return 'FULFILLED';
  if (statuses.some((s) => FINAL.includes(s) && s !== 'CANCELLED')) return 'PARTIALLY_FULFILLED';
  return 'PAID';
}

// "1 shipped · 1 ready for pickup", for the order list.
const LABELS: Record<FulfillmentGroupStatus, string> = {
  SCHEDULED: 'scheduled', PREPARING: 'preparing', IN_PRODUCTION: 'in production', READY: 'ready',
  SHIPPED: 'shipped', OUT_FOR_DELIVERY: 'out for delivery', DELIVERED: 'delivered', PICKED_UP: 'picked up', CANCELLED: 'cancelled',
};
export function statusSummary(groups: FulfillmentGroup[]): string {
  const counts = new Map<string, number>();
  for (const g of groups) {
    const label = g.status === 'READY' && g.method === 'PICKUP' ? 'ready for pickup' : LABELS[g.status];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}`).join(' · ');
}
