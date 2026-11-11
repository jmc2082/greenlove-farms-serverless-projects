import { Db, Filter, ObjectId } from 'mongodb';
import { Order, emailButton, emailLayout, escapeHtml, hashToken, newTrackingToken, sendEmail, trackingUrl } from '@greenlove/shared';
import { statusSummary } from './status';

export const orders = (db: Db) => db.collection<Order>('orders');

const ORDER_NUMBER = /^GLF-\d{4}-\d{6}$/;

// An order reference from a URL: its id or its order number (GLF-2026-000182).
export function refFilter(ref: string | undefined): Filter<Order> | null {
  if (!ref) return null;
  const upper = ref.toUpperCase();
  if (ORDER_NUMBER.test(upper)) return { orderNumber: upper };
  if (ObjectId.isValid(ref) && ref.length === 24) return { _id: new ObjectId(ref) };
  return null;
}

// One row of the order history.
export function toOrderSummary(o: Order) {
  return {
    id: o._id.toHexString(),
    orderNumber: o.orderNumber,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
    totalCents: o.totals.totalCents,
    itemCount: o.fulfillmentGroups.reduce((s, g) => s + g.items.reduce((t, i) => t + i.qty, 0), 0),
    statusSummary: statusSummary(o.fulfillmentGroups),
    groups: o.fulfillmentGroups.map((g) => ({ method: g.method, status: g.status, deliveryDate: g.deliveryDate ?? null })),
  };
}

// ── Guest tracking links ──────────────────────────────────────────────────────
// The link holds a random token; only its sha256 is stored. A new link replaces the previous one.

export { hashToken };

export async function issueTrackingLink(db: Db, order: Order): Promise<string> {
  const token = newTrackingToken();
  await orders(db).updateOne({ _id: order._id }, { $set: { guestAccessTokenHash: hashToken(token), updatedAt: new Date() } });
  return trackingUrl(token);
}

export async function emailTrackingLink(order: Order, link: string): Promise<void> {
  const name = order.contact.fullName.split(' ')[0] || 'there';
  const html = emailLayout(
    `Your order ${order.orderNumber}`,
    `<p>Hi ${escapeHtml(name)},</p>
<p>Here's the link to see the status of your GreenLove Farms order <strong>${escapeHtml(order.orderNumber)}</strong>.</p>
${emailButton(link, 'View your order')}
<p style="font-size:13px;color:#7a7f75">This link replaces any earlier one. Keep it private: anyone with it can see your order.
If you didn't ask for it, you can ignore this email.</p>`
  );
  const text = `Hi ${name},\n\nHere's the link to see the status of your GreenLove Farms order ${order.orderNumber}:\n${link}\n\nThis link replaces any earlier one. Keep it private: anyone with it can see your order. If you didn't ask for it, you can ignore this email.\n\nGreenLove Farms`;
  await sendEmail({ to: order.contact.email, subject: `Your GreenLove Farms order ${order.orderNumber}`, html, text, tag: 'order-link' });
}
