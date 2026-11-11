import { getDb } from '@greenlove/shared';
import { orderLink, orders, sendOnce } from '../lib/send';
import { confirmationEmail } from '../lib/templates';

const BATCH = 25;
const GRACE_MS = 5 * 60_000;      // give the event a head start
const LOOKBACK_MS = 3 * 86400_000; // don't email about old orders (e.g. after an outage, check those by hand)

// Every 15 minutes: send any order confirmation that hasn't gone out (a lost event, or an email that failed).
export const handler = async (): Promise<{ sent: number; failed: number }> => {
  const db = await getDb();
  const now = Date.now();
  const pending = await orders(db)
    .find(
      { 'notifications.confirmationSentAt': null, createdAt: { $lt: new Date(now - GRACE_MS), $gt: new Date(now - LOOKBACK_MS) } },
      { projection: { _id: 1, orderNumber: 1 } }
    )
    .limit(BATCH)
    .toArray();

  let sent = 0;
  let failed = 0;
  for (const p of pending) {
    try {
      const r = await sendOnce(db, p._id, 'confirmation', async (o) => confirmationEmail(o, (await orderLink(db, o, true))!), 'order-confirmation');
      if (r === 'sent') sent++;
    } catch (err) {
      failed++;
      console.error('sweep: confirmation failed', { order: p.orderNumber }, err);
    }
  }
  if (sent || failed) console.log('confirmation sweep', { sent, failed });
  return { sent, failed };
};
