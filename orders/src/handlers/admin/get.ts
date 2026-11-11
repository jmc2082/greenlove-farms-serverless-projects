import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, isStaff, ok, badRequest, forbidden, notFound, serverError } from '@greenlove/shared';
import { orders, refFilter } from '../../lib/orders';
import { toAdminOrder } from '../../lib/admin-view';

// GET /orders/admin/{ref} — by order number or id.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const filter = refFilter(event.pathParameters?.['ref']);
  if (!filter) return badRequest('Invalid order reference');
  try {
    const order = await orders(await getDb()).findOne(filter);
    return order ? ok(toAdminOrder(order)) : notFound('Order not found');
  } catch (err) {
    console.error('admin-get-order error', err);
    return serverError();
  }
};
