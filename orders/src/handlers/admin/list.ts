import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Filter } from 'mongodb';
import {
  getDb, isStaff, ok, badRequest, forbidden, serverError, Order, FULFILLMENT_METHODS, FulfillmentMethod,
  FULFILLMENT_GROUP_STATUSES, FulfillmentGroupStatus, ORDER_STATUSES, OrderStatus,
} from '@greenlove/shared';
import { orders } from '../../lib/orders';
import { toAdminOrder } from '../../lib/admin-view';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GET /orders/admin — staff order list.
 *   deliveryDate=YYYY-MM-DD   orders with a delivery or pickup on that day (the Tue/Thu run sheet)
 *   method=SHIP|LOCAL_DELIVERY|PICKUP, groupStatus=..., status=... (order status)
 *   q=  order number, email or name
 *   inventoryShort=true       paid after stock ran out: needs review
 * Delivery-day lists come soonest-first by order; everything else newest first.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const q = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));

  const filter: Filter<Order> = {};
  const group: Record<string, unknown> = {};
  if (q['deliveryDate']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q['deliveryDate'])) return badRequest('deliveryDate must be YYYY-MM-DD');
    group['deliveryDate'] = q['deliveryDate'];
  }
  if (q['method']) {
    if (!FULFILLMENT_METHODS.includes(q['method'] as FulfillmentMethod)) return badRequest(`method must be one of: ${FULFILLMENT_METHODS.join(', ')}`);
    group['method'] = q['method'];
  }
  if (q['groupStatus']) {
    if (!FULFILLMENT_GROUP_STATUSES.includes(q['groupStatus'] as FulfillmentGroupStatus)) return badRequest(`groupStatus must be one of: ${FULFILLMENT_GROUP_STATUSES.join(', ')}`);
    group['status'] = q['groupStatus'];
  }
  if (Object.keys(group).length > 0) filter.fulfillmentGroups = { $elemMatch: group };
  if (q['status']) {
    if (!ORDER_STATUSES.includes(q['status'] as OrderStatus)) return badRequest(`status must be one of: ${ORDER_STATUSES.join(', ')}`);
    filter.status = q['status'] as OrderStatus;
  }
  if (q['inventoryShort'] === 'true') filter['inventory.short'] = true;
  if (q['q']) {
    const re = new RegExp(escapeRegex(q['q'].trim().slice(0, 60)), 'i');
    filter.$or = [{ orderNumber: re }, { 'contact.email': re }, { 'contact.fullName': re }];
  }

  try {
    const col = orders(await getDb());
    const sort = group['deliveryDate'] ? { createdAt: 1 as const } : { createdAt: -1 as const };
    const [items, total] = await Promise.all([
      col.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ]);
    return ok({ items: items.map(toAdminOrder), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('admin-list-orders error', err);
    return serverError();
  }
};
