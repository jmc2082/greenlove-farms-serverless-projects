import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import {
  getDb, getClaims, isAdmin, isStaff, ok, badRequest, forbidden, notFound, conflict, serverError,
  FULFILLMENT_GROUP_STATUSES, FulfillmentGroupStatus,
} from '@greenlove/shared';
import { orders, refFilter } from '../../lib/orders';
import { checkTransition, orderStatusFor } from '../../lib/status';
import { toAdminOrder } from '../../lib/admin-view';

/**
 * PUT /orders/admin/{ref}/groups/{groupId} — body { status, trackingNumber?, trackingUrl? }
 * Moves one fulfillment group along its path (e.g. PREPARING → SHIPPED with a tracking number). The order's
 * status follows its groups. Each change is logged in the group's statusHistory with who made it.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const filter = refFilter(event.pathParameters?.['ref']);
  const groupId = event.pathParameters?.['groupId'];
  if (!filter) return badRequest('Invalid order reference');
  if (!groupId || !ObjectId.isValid(groupId)) return badRequest('Invalid group ID');

  let body: { status?: unknown; trackingNumber?: unknown; trackingUrl?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const to = body.status as FulfillmentGroupStatus;
  if (!FULFILLMENT_GROUP_STATUSES.includes(to)) return badRequest(`status must be one of: ${FULFILLMENT_GROUP_STATUSES.join(', ')}`);
  const trackingNumber = typeof body.trackingNumber === 'string' ? body.trackingNumber.trim().slice(0, 60) : undefined;
  const trackingUrl = typeof body.trackingUrl === 'string' ? body.trackingUrl.trim().slice(0, 500) : undefined;
  if (trackingUrl && !/^https:\/\//.test(trackingUrl)) return badRequest('trackingUrl must start with https://');

  try {
    const col = orders(await getDb());
    const order = await col.findOne(filter);
    if (!order) return notFound('Order not found');
    const index = order.fulfillmentGroups.findIndex((g) => g._id.equals(groupId));
    if (index < 0) return notFound('Group not found on this order');
    const group = order.fulfillmentGroups[index];

    const problem = checkTransition(group, to, isAdmin(event));
    if (problem) return badRequest(problem);
    if ((trackingNumber || trackingUrl) && group.method !== 'SHIP') return badRequest('Tracking is only for shipped groups');

    const { sub, email } = getClaims(event);
    const now = new Date();
    const groups = order.fulfillmentGroups.map((g, i) => (i === index ? { ...g, status: to } : g));
    const status = orderStatusFor({ ...order, fulfillmentGroups: groups });

    // Conditional on the group's current status, so two staff updating at once can't both apply.
    const updated = await col.findOneAndUpdate(
      { _id: order._id, fulfillmentGroups: { $elemMatch: { _id: group._id, status: group.status } } },
      {
        $set: {
          [`fulfillmentGroups.${index}.status`]: to,
          ...(trackingNumber !== undefined ? { [`fulfillmentGroups.${index}.trackingNumber`]: trackingNumber } : {}),
          ...(trackingUrl !== undefined ? { [`fulfillmentGroups.${index}.trackingUrl`]: trackingUrl } : {}),
          status,
          updatedAt: now,
        },
        $push: { [`fulfillmentGroups.${index}.statusHistory`]: { status: to, at: now, by: email || sub } },
      },
      { returnDocument: 'after' }
    );
    if (!updated) return conflict('This order was just updated by someone else. Reload and try again.');
    return ok(toAdminOrder(updated));
  } catch (err) {
    console.error('admin-group-status error', err);
    return serverError();
  }
};
