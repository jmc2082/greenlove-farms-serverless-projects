import { getDb } from '@greenlove/shared';
import { holds, releaseHold } from '../lib/holds';
import { quotes } from '../lib/quote';
import { getStripe } from '../lib/stripe';

const BATCH = 50;
const EXTEND_MS = 15 * 60_000;

/**
 * Every 5 minutes: give back stock held for payments that were never completed. A hold whose payment is
 * still processing (or already succeeded and waiting for its webhook) is extended instead.
 */
export const handler = async (): Promise<{ released: number; extended: number }> => {
  const db = await getDb();
  const now = new Date();
  const expired = await holds(db).find({ status: 'HELD', expiresAt: { $lt: now } }).limit(BATCH).toArray();
  let released = 0;
  let extended = 0;

  for (const hold of expired) {
    try {
      if (hold.paymentIntentId) {
        const stripe = await getStripe();
        let pi = await stripe.paymentIntents.retrieve(hold.paymentIntentId);
        if (pi.status !== 'canceled' && pi.status !== 'succeeded' && pi.status !== 'processing') {
          pi = await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' }).catch(() => stripe.paymentIntents.retrieve(pi.id));
        }
        if (pi.status !== 'canceled') {
          await holds(db).updateOne({ _id: hold._id }, { $set: { expiresAt: new Date(now.getTime() + EXTEND_MS), updatedAt: now } });
          extended++;
          continue;
        }
        await quotes(db).updateOne({ paymentIntentId: pi.id, status: 'PAYING' }, { $set: { status: 'OPEN', updatedAt: now } });
      }
      if (await releaseHold(db, hold._id)) released++;
    } catch (err) {
      console.error('sweep-holds: hold failed', { hold: hold._id }, err);
    }
  }

  if (released || extended) console.log('sweep-holds', { released, extended });
  return { released, extended };
};
