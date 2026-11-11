import Stripe from 'stripe';
import { Db } from 'mongodb';
import { Order, OrderRefund, publishEvent } from '@greenlove/shared';
import { orders } from './orders';
import { orderStatusFor } from './status';

const MAX_ATTEMPTS = 3;

/**
 * Reverses the sales tax for one refund: in full when the whole payment is refunded at once, otherwise the
 * same share of each tax transaction. Keyed by the Stripe refund id, so a retry (or the staff endpoint and
 * the Stripe webhook both handling the same refund) never reverses twice. A failure is logged loudly but
 * doesn't stop the refund from being recorded: the money is already back with the customer.
 */
export async function reverseTax(stripe: Stripe, order: Order, refundId: string, amountCents: number, refundedBefore: number): Promise<string[]> {
  const ids: string[] = [];
  const full = refundedBefore === 0 && amountCents === order.payment.amountCents;
  for (const [i, original] of order.tax.transactionIds.entries()) {
    try {
      const tx = await stripe.tax.transactions.retrieve(original, { expand: ['line_items'] });
      const txTotal = (tx.line_items?.data ?? []).reduce((s, l) => s + l.amount + l.amount_tax, 0)
        + (tx.shipping_cost ? tx.shipping_cost.amount + tx.shipping_cost.amount_tax : 0);
      const share = full ? 0 : Math.round((amountCents * txTotal) / order.payment.amountCents);
      if (!full && share <= 0) continue;
      const reversal = await stripe.tax.transactions.createReversal(
        {
          original_transaction: original,
          reference: `${order.orderNumber}-${refundId.slice(-10)}-${i + 1}`,
          ...(full ? { mode: 'full' as const } : { mode: 'partial' as const, flat_amount: -share }),
          metadata: { refundId },
        },
        { idempotencyKey: `taxrev-${refundId}-${i}` }
      );
      ids.push(reversal.id);
    } catch (err) {
      console.error('TAX REVERSAL FAILED: fix in Stripe Tax', { order: order.orderNumber, transaction: original, refund: refundId }, err);
    }
  }
  return ids;
}

/**
 * Adds a refund to the order (refunded total, payment and order status) and announces it, once per Stripe
 * refund id. Retries if the order changed meanwhile. Returns the updated order, or the current one if the
 * refund was already recorded.
 */
export async function recordRefund(db: Db, order: Order, entry: OrderRefund): Promise<{ order: Order; recorded: boolean }> {
  let current: Order | null = order;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && current; attempt++) {
    if ((current.refunds ?? []).some((r) => r.refundId === entry.refundId)) return { order: current, recorded: false };

    const refundedCents = Math.min(current.payment.amountCents, current.payment.refundedCents + entry.amountCents);
    const paymentStatus = refundedCents >= current.payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const updated = await orders(db).findOneAndUpdate(
      { _id: current._id, 'payment.refundedCents': current.payment.refundedCents, 'refunds.refundId': { $ne: entry.refundId } },
      {
        $set: {
          'payment.refundedCents': refundedCents,
          'payment.status': paymentStatus,
          status: orderStatusFor({ ...current, payment: { ...current.payment, status: paymentStatus } }),
          updatedAt: new Date(),
        },
        $push: { refunds: entry },
      },
      { returnDocument: 'after' }
    );
    if (updated) {
      await publishEvent({ source: 'greenlove.orders', type: 'RefundIssued', detail: { orderId: updated._id.toHexString(), refundId: entry.refundId } });
      return { order: updated, recorded: true };
    }
    current = await orders(db).findOne({ _id: order._id });
  }
  throw new Error(`Could not record refund ${entry.refundId} on ${order.orderNumber}: the order kept changing`);
}

// Stripe's refund reason → ours (Stripe leaves it empty when none was picked).
export const refundReason = (r: Stripe.Refund['reason']): OrderRefund['reason'] =>
  r === 'duplicate' ? 'duplicate' : r === 'fraudulent' ? 'fraudulent' : 'requested_by_customer';
