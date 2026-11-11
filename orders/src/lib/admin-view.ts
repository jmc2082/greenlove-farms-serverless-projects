import { Order, toPublicOrder } from '@greenlove/shared';
import { statusSummary } from './status';

// Staff shape: the shopper's view plus payment, stock, tax and refund details.
export function toAdminOrder(o: Order) {
  return {
    ...toPublicOrder(o),
    customerId: o.customerId.toHexString(),
    statusSummary: statusSummary(o.fulfillmentGroups),
    payment: { ...o.payment },
    tax: o.tax,
    inventory: o.inventory,
    refunds: (o.refunds ?? []).map((r) => ({
      ...r,
      restocked: r.restocked.map((x) => ({ variantId: x.variantId.toHexString(), qty: x.qty })),
      at: r.at.toISOString(),
    })),
    refundableCents: o.payment.amountCents - o.payment.refundedCents,
    fulfillmentGroups: o.fulfillmentGroups.map((g) => ({
      ...toPublicOrder({ ...o, fulfillmentGroups: [g] }).fulfillmentGroups[0],
      address: g.address ?? null, // includes delivery instructions
      statusHistory: g.statusHistory.map((h) => ({ status: h.status, at: h.at.toISOString(), by: h.by ?? null })),
    })),
    quoteId: o.quoteId,
    cartId: o.cartId,
    notifications: o.notifications,
    updatedAt: o.updatedAt.toISOString(),
  };
}
