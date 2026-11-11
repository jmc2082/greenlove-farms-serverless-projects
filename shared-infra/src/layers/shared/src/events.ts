import { createHash, randomBytes } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const client = new EventBridgeClient({});

// Business events on the account's default EventBridge bus. dev and prod share the bus, so every event
// carries `environment` and the notifications rules match on it.
export type GreenLoveEvent =
  | { source: 'greenlove.checkout'; type: 'OrderPaid'; detail: { orderId: string } }
  // A refund made outside our staff endpoint (e.g. in the Stripe Dashboard); the orders stack records it.
  | { source: 'greenlove.checkout'; type: 'StripeRefundCreated'; detail: { paymentIntentId: string; refundId: string } }
  | { source: 'greenlove.orders'; type: 'FulfillmentStatusChanged'; detail: { orderId: string; groupId: string; status: string } }
  | { source: 'greenlove.orders'; type: 'RefundIssued'; detail: { orderId: string; refundId: string } };

/**
 * Publishes an event and never throws: a lost event must not undo the work that caused it. Callers that
 * can't afford a lost event have a sweep as the safety net (e.g. order confirmations).
 */
export async function publishEvent(e: GreenLoveEvent): Promise<boolean> {
  try {
    const res = await client.send(
      new PutEventsCommand({
        Entries: [{ Source: e.source, DetailType: e.type, Detail: JSON.stringify({ ...e.detail, environment: process.env.ENVIRONMENT }) }],
      })
    );
    if (res.FailedEntryCount) {
      console.error('event not published', { type: e.type, entry: res.Entries?.[0] });
      return false;
    }
    return true;
  } catch (err) {
    console.error('event not published', { type: e.type }, err);
    return false;
  }
}

// ── Guest tracking links ──────────────────────────────────────────────────────
// The link holds a random token; only its sha256 is stored on the order (guestAccessTokenHash).

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newTrackingToken = () => randomBytes(32).toString('base64url');
export const trackingUrl = (token: string) => `${process.env.WEB_URL}/orders/track?token=${token}`;
export const accountOrderUrl = (orderNumber: string) => `${process.env.WEB_URL}/account/orders/${orderNumber}`;
