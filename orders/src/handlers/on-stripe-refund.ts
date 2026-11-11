import { EventBridgeEvent } from 'aws-lambda';
import { getDb } from '@greenlove/shared';
import { orders } from '../lib/orders';
import { recordRefund, refundReason, reverseTax } from '../lib/refunds';
import { getStripe } from '../lib/stripe';

type Detail = { paymentIntentId?: string; refundId?: string };

/**
 * StripeRefundCreated (from the checkout webhook): a refund made outside our staff endpoint, usually in the
 * Stripe Dashboard. Records it like a staff refund (tax reversal, refunded total, status, email) but without
 * restocking, since Stripe doesn't know which items came back. Throws on failure so the event is retried.
 */
export const handler = async (event: EventBridgeEvent<'StripeRefundCreated', Detail>): Promise<void> => {
  const { paymentIntentId, refundId } = event.detail;
  if (!paymentIntentId || !refundId) return;

  const db = await getDb();
  const order = await orders(db).findOne({ 'payment.paymentIntentId': paymentIntentId });
  if (!order) {
    console.warn('refund for a payment with no order', { paymentIntentId, refundId });
    return;
  }
  if ((order.refunds ?? []).some((r) => r.refundId === refundId)) return;

  const stripe = await getStripe();
  const refund = await stripe.refunds.retrieve(refundId);
  if (refund.status === 'failed' || refund.status === 'canceled') {
    console.warn('refund did not go through; not recorded', { order: order.orderNumber, refundId, status: refund.status });
    return;
  }

  const taxReversalIds = await reverseTax(stripe, order, refund.id, refund.amount, order.payment.refundedCents);
  const { recorded } = await recordRefund(db, order, {
    refundId: refund.id,
    amountCents: refund.amount,
    reason: refundReason(refund.reason),
    note: 'Refunded in the Stripe Dashboard',
    restocked: [],
    taxReversalIds,
    by: { sub: 'stripe', email: '' },
    at: new Date(refund.created * 1000),
  });
  if (recorded) console.log('dashboard refund recorded', { order: order.orderNumber, refundId, amount: refund.amount });
};
