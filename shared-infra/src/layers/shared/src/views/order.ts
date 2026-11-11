import { Order } from '../types/order';

// What the shopper sees: no internal ids for stock, tax or holds.
export function toPublicOrder(o: Order) {
  return {
    id: o._id.toHexString(),
    orderNumber: o.orderNumber,
    status: o.status,
    placedBy: o.placedBy,
    contact: o.contact,
    totals: o.totals,
    promotion: o.promotion ? { code: o.promotion.code, savingsCents: o.promotion.discountCents + o.promotion.feeDiscountCents } : null,
    payment: { status: o.payment.status, method: o.payment.method ?? null, refundedCents: o.payment.refundedCents },
    fulfillmentGroups: o.fulfillmentGroups.map((g) => ({
      id: g._id.toHexString(),
      fulfillmentClass: g.fulfillmentClass,
      method: g.method,
      status: g.status,
      pickupLocation: g.pickupLocation ?? null,
      address: g.address ?? null,
      deliveryDate: g.deliveryDate ?? null,
      shipsWithinDays: g.shipsWithinDays ?? null,
      trackingNumber: g.trackingNumber ?? null,
      trackingUrl: g.trackingUrl ?? null,
      feeCents: g.feeCents,
      taxCents: g.taxCents,
      items: g.items.map((i) => ({
        productId: i.productId.toHexString(),
        variantId: i.variantId.toHexString(),
        name: i.name,
        variantName: i.variantName,
        sku: i.sku,
        qty: i.qty,
        unitPriceCents: i.unitPriceCents,
        discountCents: i.discountCents,
        lineTotalCents: i.lineTotalCents,
      })),
      statusHistory: g.statusHistory.map((h) => ({ status: h.status, at: h.at.toISOString() })),
    })),
    createdAt: o.createdAt.toISOString(),
  };
}
