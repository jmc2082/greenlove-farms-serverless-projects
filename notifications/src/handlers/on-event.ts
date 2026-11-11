import { EventBridgeEvent } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb } from '@greenlove/shared';
import { orderLink, sendOnce } from '../lib/send';
import { STATUS_EMAILS, confirmationEmail, refundEmail, statusEmail } from '../lib/templates';

type Detail = { orderId?: string; groupId?: string; status?: string; refundId?: string; environment?: string };

/**
 * EventBridge → shopper emails. OrderPaid: confirmation. FulfillmentStatusChanged: shipped, ready for pickup,
 * out for delivery, cancelled. RefundIssued: refund notice. Throws on failure so the event is retried.
 */
export const handler = async (event: EventBridgeEvent<string, Detail>): Promise<void> => {
  const d = event.detail;
  if (!d.orderId || !ObjectId.isValid(d.orderId)) {
    console.warn('event without a valid orderId', { type: event['detail-type'] });
    return;
  }
  const orderId = new ObjectId(d.orderId);
  const db = await getDb();

  switch (event['detail-type']) {
    case 'OrderPaid':
      await sendOnce(db, orderId, 'confirmation', async (o) => confirmationEmail(o, (await orderLink(db, o, true))!), 'order-confirmation');
      return;

    case 'FulfillmentStatusChanged': {
      if (!d.groupId || !STATUS_EMAILS.includes(d.status as (typeof STATUS_EMAILS)[number])) return;
      await sendOnce(db, orderId, `status:${d.groupId}:${d.status}`, async (o) => {
        const g = o.fulfillmentGroups.find((x) => x._id.equals(d.groupId!));
        // The group may have moved on again before this ran; only email about where it is now.
        if (!g || g.status !== d.status) return null;
        return statusEmail(o, g, await orderLink(db, o, false));
      }, 'order-status');
      return;
    }

    case 'RefundIssued':
      if (!d.refundId) return;
      await sendOnce(db, orderId, `refund:${d.refundId}`, async (o) => {
        const r = (o.refunds ?? []).find((x) => x.refundId === d.refundId);
        return r ? refundEmail(o, r, await orderLink(db, o, false)) : null;
      }, 'order-refund');
      return;

    default:
      console.warn('unhandled event', { type: event['detail-type'] });
  }
};
