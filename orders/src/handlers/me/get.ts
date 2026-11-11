import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, toPublicOrder } from '@greenlove/shared';
import { customerIdFor } from '../../lib/customer';
import { orders, refFilter } from '../../lib/orders';

// GET /orders/me/{ref} — one of the signed-in shopper's orders, by order number (GLF-2026-000182) or id.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  const filter = refFilter(event.pathParameters?.['ref']);
  if (!filter) return badRequest('Invalid order reference');

  try {
    const db = await getDb();
    const customerId = await customerIdFor(db, event);
    const order = customerId ? await orders(db).findOne({ ...filter, customerId }) : null;
    return order ? ok(toPublicOrder(order)) : notFound('Order not found');
  } catch (err) {
    console.error('get-my-order error', err);
    return serverError();
  }
};
