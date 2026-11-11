import { Db, ObjectId } from 'mongodb';
import { Order, accountOrderUrl, hashToken, newTrackingToken, sendEmail, trackingUrl } from '@greenlove/shared';
import { RenderedEmail } from './templates';

export const orders = (db: Db) => db.collection<Order>('orders');

// A claim older than this is assumed to have crashed mid-send and may be retried.
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Sends one email for an order at most once per `key`. The key is claimed on the order first (so a repeated
 * event, or the sweep running alongside, can't send twice), then marked sent. A failed send releases the
 * claim and rethrows, so EventBridge / Lambda retry it.
 */
export async function sendOnce(db: Db, orderId: ObjectId, key: string, render: (o: Order) => Promise<RenderedEmail | null>, tag: string): Promise<'sent' | 'skipped'> {
  const now = new Date();
  // Drop a stale claim for this key, then claim it.
  await orders(db).updateOne(
    { _id: orderId },
    { $pull: { 'notifications.sent': { key, sentAt: null, claimedAt: { $lt: new Date(now.getTime() - STALE_CLAIM_MS) } } } }
  );
  const order = await orders(db).findOneAndUpdate(
    { _id: orderId, 'notifications.sent.key': { $ne: key } },
    { $push: { 'notifications.sent': { key, claimedAt: now, sentAt: null } } },
    { returnDocument: 'after' }
  );
  if (!order) return 'skipped'; // already sent, being sent, or no such order

  // Reserved test domains never receive mail; sending would only bounce and hurt our SES reputation.
  if (/@(example\.(com|net|org)|[^@]+\.(test|invalid|example))$/i.test(order.contact.email)) {
    await orders(db).updateOne(
      { _id: orderId, 'notifications.sent.key': key },
      {
        $set: {
          'notifications.sent.$.sentAt': new Date(),
          'notifications.sent.$.messageId': 'skipped-test-address',
          ...(key === 'confirmation' ? { 'notifications.confirmationSentAt': new Date() } : {}),
        },
      }
    );
    console.log('email skipped (test address)', { order: order.orderNumber, key });
    return 'skipped';
  }

  try {
    const email = await render(order);
    if (!email) {
      await orders(db).updateOne({ _id: orderId }, { $pull: { 'notifications.sent': { key } } });
      return 'skipped';
    }
    const messageId = await sendEmail({ to: order.contact.email, subject: email.subject, html: email.html, text: email.text, tag });
    await orders(db).updateOne(
      { _id: orderId, 'notifications.sent.key': key },
      {
        $set: {
          'notifications.sent.$.sentAt': new Date(),
          'notifications.sent.$.messageId': messageId,
          ...(key === 'confirmation' ? { 'notifications.confirmationSentAt': new Date() } : {}),
        },
      }
    );
    console.log('email sent', { order: order.orderNumber, key, messageId });
    return 'sent';
  } catch (err) {
    await orders(db).updateOne({ _id: orderId }, { $pull: { 'notifications.sent': { key, sentAt: null } } });
    throw err;
  }
}

/**
 * The link an email should carry. Signed-in shoppers: their account's order page. Guests: a tracking link,
 * minted only with the confirmation (a new token would invalidate the one already emailed), so later
 * emails to guests point back to the confirmation instead.
 */
export async function orderLink(db: Db, o: Order, mintForGuest: boolean): Promise<string | null> {
  if (o.placedBy === 'CUSTOMER') return accountOrderUrl(o.orderNumber);
  if (!mintForGuest) return null;
  const token = newTrackingToken();
  await orders(db).updateOne({ _id: o._id }, { $set: { guestAccessTokenHash: hashToken(token), updatedAt: new Date() } });
  return trackingUrl(token);
}
