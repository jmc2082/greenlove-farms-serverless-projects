import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { getDb, ok, badRequest, serverError } from '@greenlove/shared';
import { getStripe, getWebhookSecret } from '../lib/stripe';
import { createOrderForPayment } from '../lib/orders';
import { quotes } from '../lib/quote';
import { releaseHold } from '../lib/holds';

interface WebhookEvent { _id: string; type: string; receivedAt: Date; processedAt: Date | null; expiresAt: Date }

/**
 * POST /checkout/webhooks/stripe — Stripe calls this; no auth beyond the signature.
 * Events: payment_intent.succeeded (create the order), payment_intent.payment_failed (remember the reason),
 * payment_intent.canceled (release the stock hold). Answers 500 on failure so Stripe retries; every
 * step is safe to repeat. Events already processed are skipped.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const signature = event.headers['stripe-signature'];
  if (!signature || !event.body) return badRequest('Missing signature');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let stripe: Stripe;
  let evt: Stripe.Event;
  try {
    stripe = await getStripe();
    evt = await stripe.webhooks.constructEventAsync(raw, signature, await getWebhookSecret());
  } catch (err) {
    console.warn('stripe webhook rejected', (err as Error).message);
    return badRequest('Invalid signature');
  }

  try {
    const db = await getDb();
    const log = db.collection<WebhookEvent>('webhookEvents');
    const seen = await log.findOne({ _id: evt.id });
    if (seen?.processedAt) return ok({ received: true, duplicate: true });

    const now = new Date();
    await log.updateOne(
      { _id: evt.id },
      { $setOnInsert: { type: evt.type, receivedAt: now, processedAt: null, expiresAt: new Date(now.getTime() + 30 * 86400_000) } },
      { upsert: true }
    );

    switch (evt.type) {
      case 'payment_intent.succeeded': {
        // Re-read with the charge expanded, for the card brand and last 4 digits.
        const pi = await stripe.paymentIntents.retrieve(evt.data.object.id, { expand: ['latest_charge'] });
        const order = await createOrderForPayment(db, stripe, pi);
        if (order) console.log('order created', { orderNumber: order.orderNumber, paymentIntent: pi.id });
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = evt.data.object;
        await quotes(db).updateOne(
          { paymentIntentId: pi.id },
          { $set: { lastPaymentError: pi.last_payment_error?.message ?? 'Payment failed', updatedAt: now } }
        );
        break; // the shopper can retry with the same payment; the hold stays until it expires
      }
      case 'payment_intent.canceled': {
        const pi = evt.data.object;
        if (pi.metadata?.['holdId']) await releaseHold(db, pi.metadata['holdId']);
        await quotes(db).updateOne({ paymentIntentId: pi.id, status: 'PAYING' }, { $set: { status: 'OPEN', updatedAt: now } });
        break;
      }
      default:
        break; // not subscribed; ignore
    }

    await log.updateOne({ _id: evt.id }, { $set: { processedAt: new Date() } });
    return ok({ received: true });
  } catch (err) {
    console.error('stripe webhook error', { id: evt.id, type: evt.type }, err);
    return serverError();
  }
};
