import { APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { Db } from 'mongodb';
import { getDb, ok, badRequest, notFound, conflict, serverError } from '@greenlove/shared';
import { CheckoutEvent, loadShopper, ownsQuote, parseBody } from '../lib/access';
import { CheckoutQuote, buildQuote, quotes, sha256, toQuoteView } from '../lib/quote';
import { holds, placeHold, releaseHold } from '../lib/holds';
import { CheckoutSettings, getSettings } from '../lib/settings';
import { getStripe } from '../lib/stripe';

const LOCK_MS = 20_000;
const OPEN_STATES: Stripe.PaymentIntent.Status[] = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

const conflictWith = (error: string, message: string, extra: Record<string, unknown> = {}): APIGatewayProxyResultV2 => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error, message, ...extra }),
});

/**
 * POST /checkout/pay (guest) | POST /checkout/me/pay — body { quoteId, cartId? (guest), labelsReviewed? }
 * Re-prices the quote from the current cart and catalog. If anything changed, answers 409 with the new
 * quote for the shopper to confirm. Otherwise holds the stock and returns a PaymentIntent client secret for
 * stripe.confirmPayment(). Calling again for the same quote returns the same payment while it's still open.
 */
export const handler = async (event: CheckoutEvent): Promise<APIGatewayProxyResultV2> => {
  const body = parseBody(event);
  if (!body) return badRequest('Invalid JSON body');
  const quoteId = body['quoteId'];
  if (typeof quoteId !== 'string' || quoteId.length > 64) return badRequest('quoteId is required');

  let locked: CheckoutQuote | null = null;
  let db: Db | null = null;
  try {
    db = await getDb();
    const shopper = await loadShopper(db, event, body['cartId']);
    if (!shopper.ok) return shopper.error;

    const quote = await quotes(db).findOne({ _id: quoteId });
    if (!quote || !ownsQuote(quote, shopper)) return notFound('Quote not found');
    if (quote.status === 'PAID') return conflictWith('ALREADY_PAID', 'This order has already been paid.');
    if (quote.status === 'CANCELED') return conflictWith('QUOTE_REPLACED', 'This checkout was updated. Review your order and try again.');
    if (quote.requiresLabelAck && body['labelsReviewed'] !== true) return badRequest('Please confirm you have reviewed the product labels.');

    // One /pay at a time per quote, so a double-click can't hold stock twice.
    const now = new Date();
    locked = await quotes(db).findOneAndUpdate(
      { _id: quoteId, status: { $in: ['OPEN', 'PAYING'] }, $or: [{ payingLockUntil: null }, { payingLockUntil: { $lt: now } }] },
      { $set: { payingLockUntil: new Date(now.getTime() + LOCK_MS) } },
      { returnDocument: 'after' }
    );
    if (!locked) return conflict('Your payment is already being set up. Try again in a moment.');

    const settings = await getSettings(db);
    const stripe = await getStripe();
    const fresh = await buildQuote({ db, settings, cart: shopper.cart, customer: shopper.customer, inputs: locked.inputs, now });

    if (!fresh.payable || fresh.fingerprint !== locked.fingerprint) {
      await abandonPayment(db, stripe, locked);
      await quotes(db).insertOne(fresh);
      await quotes(db).updateOne({ _id: locked._id }, { $set: { status: 'CANCELED', payingLockUntil: null, updatedAt: now } });
      locked = null;
      return fresh.payable
        ? conflictWith('QUOTE_CHANGED', 'Your order changed since you reviewed it. Please check the new total.', { quote: toQuoteView(fresh, settings) })
        : conflictWith('QUOTE_NOT_PAYABLE', fresh.issues[0]?.message ?? 'Your order can’t be paid yet.', { quote: toQuoteView(fresh, settings) });
    }

    // Same payment still open: hand it back (and keep its stock held).
    if (locked.status === 'PAYING' && locked.paymentIntentId && locked.holdId) {
      const pi = await stripe.paymentIntents.retrieve(locked.paymentIntentId);
      if (pi.status === 'succeeded' || pi.status === 'processing') {
        return conflictWith('ALREADY_PAID', 'This order has already been paid.', { paymentIntentId: pi.id });
      }
      if (OPEN_STATES.includes(pi.status)) {
        const extended = await holds(db).updateOne(
          { _id: locked.holdId, status: 'HELD' },
          { $set: { expiresAt: new Date(now.getTime() + settings.holdMinutes * 60_000), updatedAt: now } }
        );
        if (extended.modifiedCount === 1) return ok(payResponse(locked, pi));
      }
      await abandonPayment(db, stripe, locked);
    }

    return await startPayment(db, stripe, settings, locked, now);
  } catch (err) {
    console.error('checkout-pay error', err);
    return serverError();
  } finally {
    if (db && locked) await quotes(db).updateOne({ _id: locked._id }, { $set: { payingLockUntil: null } }).catch(() => undefined);
  }
};

async function startPayment(db: Db, stripe: Stripe, settings: CheckoutSettings, quote: CheckoutQuote, now: Date) {
  const attempt = quote.attempt + 1;
  const holdId = `${quote._id}:${attempt}`;
  const items = quote.groups.flatMap((g) => g.items);

  const held = await placeHold(db, holdId, quote._id, items, new Date(now.getTime() + settings.holdMinutes * 60_000));
  if (!held.ok) {
    return conflictWith('NOT_ENOUGH_STOCK', 'Some items sold out while you were checking out.', { shortages: held.shortages });
  }

  const contact = quote.contact!;
  const shipTo = quote.groups.find((g) => g.address)?.address;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: quote.totals.totalCents!,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        receipt_email: contact.email,
        description: 'GreenLove Farms order',
        metadata: { quoteId: quote._id, holdId, cartId: quote.cartId, environment: process.env.ENVIRONMENT ?? '' },
        ...(shipTo
          ? { shipping: { name: shipTo.name || contact.fullName, phone: contact.phone || undefined, address: { line1: shipTo.line1, line2: shipTo.line2, city: shipTo.city, state: shipTo.state, postal_code: shipTo.zip, country: 'US' } } }
          : {}),
      },
      { idempotencyKey: `pi-${holdId}` }
    );
  } catch (err) {
    await releaseHold(db, holdId);
    throw err;
  }

  await holds(db).updateOne({ _id: holdId }, { $set: { paymentIntentId: pi.id } });
  const updated = { ...quote, status: 'PAYING' as const, attempt, holdId, paymentIntentId: pi.id };
  await quotes(db).updateOne(
    { _id: quote._id },
    {
      $set: {
        status: 'PAYING', attempt, holdId, paymentIntentId: pi.id, clientSecretHash: sha256(pi.client_secret!),
        lastPaymentError: null, updatedAt: now, expiresAt: new Date(now.getTime() + 30 * 86400_000),
      },
    }
  );
  return ok(payResponse(updated, pi));
}

const payResponse = (q: CheckoutQuote, pi: Stripe.PaymentIntent) => ({
  quoteId: q._id,
  paymentIntentId: pi.id,
  clientSecret: pi.client_secret,
  amountCents: pi.amount,
  currency: pi.currency,
});

// Cancel the quote's open PaymentIntent (if Stripe still allows it) and give its stock back.
async function abandonPayment(db: Db, stripe: Stripe, quote: CheckoutQuote) {
  if (quote.paymentIntentId) {
    try {
      await stripe.paymentIntents.cancel(quote.paymentIntentId, { cancellation_reason: 'abandoned' });
    } catch (err) {
      const pi = await stripe.paymentIntents.retrieve(quote.paymentIntentId);
      if (pi.status !== 'canceled') throw err; // e.g. it was just paid: keep the hold for the webhook
    }
  }
  if (quote.holdId) await releaseHold(db, quote.holdId);
}
