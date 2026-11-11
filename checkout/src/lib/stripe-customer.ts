import Stripe from 'stripe';
import { Db } from 'mongodb';
import { Customer } from '@greenlove/shared';

/**
 * The shopper's Stripe Customer (for saved cards), created on first use. The idempotency key is per customer,
 * so two requests racing to create it get the same Stripe Customer, and only the first one is stored.
 */
export async function ensureStripeCustomer(db: Db, stripe: Stripe, customer: Customer): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;

  const created = await stripe.customers.create(
    {
      email: customer.email,
      name: customer.fullName || undefined,
      metadata: { customerId: customer._id.toHexString(), environment: process.env.ENVIRONMENT ?? '' },
    },
    { idempotencyKey: `cus-${process.env.ENVIRONMENT}-${customer._id.toHexString()}` }
  );
  const col = db.collection<Customer>('customers');
  await col.updateOne(
    { _id: customer._id, $or: [{ stripeCustomerId: null }, { stripeCustomerId: { $exists: false } }] },
    { $set: { stripeCustomerId: created.id, updatedAt: new Date() } }
  );
  const saved = await col.findOne({ _id: customer._id }, { projection: { stripeCustomerId: 1 } });
  return saved?.stripeCustomerId ?? created.id;
}

// Saved cards the shopper agreed to keep (the Payment Element's "Save this card" sets allow_redisplay=always).
export const toSavedCard = (pm: Stripe.PaymentMethod) => ({
  id: pm.id,
  brand: pm.card?.brand ?? pm.type,
  last4: pm.card?.last4 ?? null,
  expMonth: pm.card?.exp_month ?? null,
  expYear: pm.card?.exp_year ?? null,
  wallet: pm.card?.wallet?.type ?? null, // apple_pay, google_pay, link…
});
