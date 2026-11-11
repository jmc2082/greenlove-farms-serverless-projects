import Stripe from 'stripe';
import { Db, ObjectId } from 'mongodb';
import { Customer, FulfillmentGroup, Order, Promotion, PromotionRedemption, farmYear, publishEvent } from '@greenlove/shared';
import { CheckoutQuote, quotes } from './quote';
import { commitStock } from './holds';

export const orders = (db: Db) => db.collection<Order>('orders');

async function nextOrderNumber(db: Db, at: Date): Promise<string> {
  const year = farmYear(at);
  const counter = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate({ _id: `order-${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `GLF-${year}-${String(counter!.seq).padStart(6, '0')}`;
}

// Guests get a customers record keyed by email (cognitoSub null). Signing up later with that email claims it,
// and with it these orders. An existing record is never modified here.
async function guestCustomerId(db: Db, contact: NonNullable<CheckoutQuote['contact']>, now: Date): Promise<ObjectId> {
  const res = await db.collection<Customer>('customers').findOneAndUpdate(
    { email: contact.email },
    {
      $setOnInsert: {
        email: contact.email, cognitoSub: null, fullName: contact.fullName, phone: contact.phone,
        addresses: [], consent: { marketingEmail: null, sms: null }, createdAt: now, updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after', projection: { _id: 1 } }
  );
  return res!._id;
}

function paymentMethodOf(pi: Stripe.PaymentIntent): Order['payment']['method'] {
  const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const details = charge?.payment_method_details;
  if (!details) return undefined;
  return { type: details.type, brand: details.card?.brand ?? undefined, last4: details.card?.last4 ?? undefined };
}

/**
 * payment_intent.succeeded → order. Every step is safe to repeat (Stripe may deliver an event twice, or
 * retry after a timeout): the order is unique per PaymentIntent, stock moves once per hold, the tax
 * transaction uses an idempotency key.
 */
export async function createOrderForPayment(db: Db, stripe: Stripe, pi: Stripe.PaymentIntent): Promise<Order | null> {
  const quoteId = pi.metadata?.['quoteId'];
  const quote = quoteId ? await quotes(db).findOne({ _id: quoteId }) : null;
  if (!quote) {
    console.error('payment succeeded for an unknown quote', { paymentIntent: pi.id, quoteId });
    return null;
  }
  if (quote.paymentIntentId !== pi.id) console.warn('payment is not the quote’s latest attempt', { paymentIntent: pi.id, quoteId });
  if (pi.amount !== quote.totals.totalCents) console.error('paid amount differs from quote total', { paymentIntent: pi.id, amount: pi.amount, total: quote.totals.totalCents });

  const now = new Date();
  let order = await orders(db).findOne({ 'payment.paymentIntentId': pi.id });

  if (!order) {
    const contact = quote.contact!;
    const customerId = quote.customerId ?? (await guestCustomerId(db, contact, now));
    const groups: FulfillmentGroup[] = quote.groups.map((g) => ({
      _id: new ObjectId(),
      fulfillmentClass: g.fulfillmentClass,
      method: g.method!,
      status: g.method === 'SHIP' ? 'PREPARING' : 'SCHEDULED',
      items: g.items.map((i) => ({
        productId: i.productId, variantId: i.variantId, name: i.name, variantName: i.variantName, sku: i.sku,
        qty: i.qty, unitPriceCents: i.unitPriceCents, discountCents: i.discountCents, taxCents: i.taxCents, lineTotalCents: i.lineTotalCents,
      })),
      ...(g.pickupLocation ? { pickupLocation: { id: g.pickupLocation.id, name: g.pickupLocation.name } } : {}),
      ...(g.address ? { address: g.address } : {}),
      ...(g.deliveryDate ? { deliveryDate: g.deliveryDate } : {}),
      ...(g.shipsWithinDays !== null ? { shipsWithinDays: g.shipsWithinDays } : {}),
      feeCents: g.feeCents,
      taxCents: g.taxCents ?? 0,
      statusHistory: [{ status: g.method === 'SHIP' ? 'PREPARING' : 'SCHEDULED', at: now }],
    }));

    const fresh: Order = {
      _id: new ObjectId(),
      orderNumber: await nextOrderNumber(db, now),
      customerId,
      placedBy: quote.placedBy,
      contact,
      status: 'PAID',
      totals: { ...quote.totals, taxCents: quote.totals.taxCents ?? 0, totalCents: pi.amount },
      payment: {
        provider: 'STRIPE', paymentIntentId: pi.id, status: 'SUCCEEDED', amountCents: pi.amount, currency: 'usd',
        method: paymentMethodOf(pi), refundedCents: 0,
      },
      ...(quote.promotion?.applied && quote.promotion.promotionId
        ? { promotion: { promotionId: quote.promotion.promotionId, code: quote.promotion.code, discountCents: quote.promotion.discountCents, feeDiscountCents: quote.promotion.feeDiscountCents } }
        : {}),
      tax: { calculationIds: quote.tax.map((t) => t.calculationId), transactionIds: [] },
      fulfillmentGroups: groups,
      quoteId: quote._id,
      cartId: quote.cartId,
      inventory: { committedAt: null, short: false },
      guestAccessTokenHash: null,
      notifications: { confirmationSentAt: null },
      createdAt: now,
      updatedAt: now,
    };
    try {
      await orders(db).insertOne(fresh);
      order = fresh;
    } catch (err) {
      // Another delivery of this event got there first.
      // Checked by code, not instanceof: the driver class may come from another module copy.
      if ((err as { code?: number }).code !== 11000) throw err;
      order = await orders(db).findOne({ 'payment.paymentIntentId': pi.id });
      if (!order) throw err;
    }
  }

  // Follow-ups, each idempotent.
  if (!order.inventory.committedAt) {
    const holdId = pi.metadata?.['holdId'] ?? quote.holdId;
    const { short } = await commitStock(db, holdId, quote.groups.flatMap((g) => g.items));
    await orders(db).updateOne({ _id: order._id }, { $set: { inventory: { committedAt: new Date(), short }, updatedAt: new Date() } });
  }
  if (order.promotion) await recordRedemption(db, order);
  await quotes(db).updateOne(
    { _id: quote._id },
    { $set: { status: 'PAID', orderId: order._id, updatedAt: now, expiresAt: new Date(now.getTime() + 30 * 86400_000) } }
  );
  await db.collection('carts').updateOne(
    { _id: quote.cartId as never, status: 'ACTIVE' },
    { $set: { status: 'CONVERTED', orderId: order._id, updatedAt: now } }
  );

  // Record the sale in Stripe Tax so it shows in filing reports.
  const missing = order.tax.calculationIds.slice(order.tax.transactionIds.length);
  for (const calculationId of missing) {
    const tx = await stripe.tax.transactions.createFromCalculation(
      { calculation: calculationId, reference: `${order.orderNumber}-${order.tax.calculationIds.indexOf(calculationId) + 1}`, metadata: { orderId: order._id.toHexString() } },
      { idempotencyKey: `taxtx-${pi.id}-${calculationId}` }
    );
    await orders(db).updateOne({ _id: order._id }, { $addToSet: { 'tax.transactionIds': tx.id }, $set: { updatedAt: new Date() } });
  }

  // The notifications stack sends the confirmation email (and a sweep catches it if this event is lost).
  if (!order.notifications.confirmationSentAt) {
    await publishEvent({ source: 'greenlove.checkout', type: 'OrderPaid', detail: { orderId: order._id.toHexString() } });
  }
  return order;
}

// The code's use counts only once the payment succeeds, so a failed payment never uses it up.
// The unique (promotionId, orderId) index makes this run once per order, and the count rises only then.
async function recordRedemption(db: Db, order: Order) {
  const p = order.promotion!;
  try {
    await db.collection<PromotionRedemption>('promotionRedemptions').insertOne({
      _id: new ObjectId(),
      promotionId: p.promotionId,
      code: p.code,
      orderId: order._id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.contact.email,
      discountCents: p.discountCents,
      feeDiscountCents: p.feeDiscountCents,
      createdAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // already recorded
    throw err;
  }
  await db.collection<Promotion>('promotions').updateOne({ _id: p.promotionId }, { $inc: { redemptionCount: 1 } });
}
