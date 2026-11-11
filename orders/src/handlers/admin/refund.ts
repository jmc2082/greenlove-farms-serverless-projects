import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
  getDb, getClaims, isStaff, ok, badRequest, forbidden, notFound, serverError, OrderRefund, Product,
} from '@greenlove/shared';
import { orders, refFilter } from '../../lib/orders';
import { recordRefund, reverseTax } from '../../lib/refunds';
import { toAdminOrder } from '../../lib/admin-view';
import { getStripe } from '../../lib/stripe';

const REASONS = ['requested_by_customer', 'duplicate', 'fraudulent'] as const;

/**
 * POST /orders/admin/{ref}/refunds — body { amountCents?, reason?, note?, restock?: [{ variantId, qty }] }
 * Refunds through Stripe (whole remaining amount when amountCents is left out), reverses the matching share
 * of sales tax in Stripe Tax, and optionally puts items back in stock. Staff only.
 * Refunds made in the Stripe Dashboard are recorded by the Stripe webhook instead (without restocking).
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const filter = refFilter(event.pathParameters?.['ref']);
  if (!filter) return badRequest('Invalid order reference');

  let body: { amountCents?: unknown; reason?: unknown; note?: unknown; restock?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const reason = (body.reason ?? 'requested_by_customer') as OrderRefund['reason'];
  if (!REASONS.includes(reason)) return badRequest(`reason must be one of: ${REASONS.join(', ')}`);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';

  try {
    const db = await getDb();
    const order = await orders(db).findOne(filter);
    if (!order) return notFound('Order not found');

    const refundable = order.payment.amountCents - order.payment.refundedCents;
    const amount = body.amountCents === undefined ? refundable : body.amountCents;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) return badRequest('amountCents must be a whole number of cents, at least 1');
    if (amount > refundable) return badRequest(`Only ${refundable} cents can still be refunded`);

    // Restock: only items on this order, never more than were bought (less anything restocked before).
    const items = order.fulfillmentGroups.flatMap((g) => g.items);
    const restock: { productId: ObjectId; variantId: ObjectId; qty: number }[] = [];
    if (body.restock !== undefined) {
      if (!Array.isArray(body.restock)) return badRequest('restock must be a list of { variantId, qty }');
      for (const r of body.restock as { variantId?: unknown; qty?: unknown }[]) {
        const item = typeof r?.variantId === 'string' ? items.find((i) => i.variantId.equals(r.variantId as string)) : undefined;
        if (!item) return badRequest('restock lists an item that isn’t on this order');
        const before = (order.refunds ?? []).flatMap((x) => x.restocked).filter((x) => x.variantId.equals(item.variantId)).reduce((s, x) => s + x.qty, 0);
        if (typeof r.qty !== 'number' || !Number.isInteger(r.qty) || r.qty < 1 || r.qty > item.qty - before) {
          return badRequest(`restock qty for ${item.sku} must be 1 to ${item.qty - before}`);
        }
        restock.push({ productId: item.productId, variantId: item.variantId, qty: r.qty });
      }
    }

    const stripe = await getStripe();
    // The key ties this request to the order's refund state, so a double-click can't refund twice.
    // source=admin tells the Stripe webhook this refund is recorded here, not by it.
    const refund = await stripe.refunds.create(
      { payment_intent: order.payment.paymentIntentId, amount, reason, metadata: { orderNumber: order.orderNumber, source: 'admin' } },
      { idempotencyKey: `refund-${order._id.toHexString()}-${order.payment.refundedCents}-${amount}` }
    );
    const taxReversalIds = await reverseTax(stripe, order, refund.id, amount, order.payment.refundedCents);

    // Put restocked units back on the shelf, and log each like any other stock adjustment.
    const { sub, email } = getClaims(event);
    const now = new Date();
    for (const r of restock) {
      const p = await db.collection<Product>('products').findOneAndUpdate(
        { _id: r.productId },
        { $inc: { 'variants.$[v].inventory.onHand': r.qty, version: 1 }, $set: { updatedAt: now } },
        { arrayFilters: [{ 'v._id': r.variantId, 'v.inventory': { $exists: true } }], returnDocument: 'after' }
      );
      const v = p?.variants.find((x) => x._id.equals(r.variantId));
      await db.collection('inventoryAdjustments').insertOne({
        productId: r.productId, variantId: r.variantId, sku: v?.sku, delta: r.qty, reason: 'REFUND_RESTOCK',
        note: `Order ${order.orderNumber}`, onHandAfter: v?.inventory?.onHand, actorSub: sub, actorEmail: email, createdAt: now,
      });
    }

    const { order: updated } = await recordRefund(db, order, {
      refundId: refund.id, amountCents: amount, reason, note,
      restocked: restock.map((r) => ({ variantId: r.variantId, qty: r.qty })),
      taxReversalIds, by: { sub, email }, at: now,
    });
    return ok(toAdminOrder(updated));
  } catch (err) {
    const stripeMessage = (err as { type?: string; message?: string }).type?.startsWith('Stripe') ? (err as Error).message : null;
    if (stripeMessage) return badRequest(`Stripe refused the refund: ${stripeMessage}`);
    console.error('admin-refund error', err);
    return serverError();
  }
};
