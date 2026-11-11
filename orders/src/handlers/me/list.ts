import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, serverError } from '@greenlove/shared';
import { customerIdFor } from '../../lib/customer';
import { orders, toOrderSummary } from '../../lib/orders';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// GET /orders/me?page=&limit= — the signed-in shopper's orders, newest first.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  const q = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));

  try {
    const db = await getDb();
    const customerId = await customerIdFor(db, event);
    if (!customerId) return ok({ items: [], page, limit, total: 0, totalPages: 0 });

    const filter = { customerId };
    const [items, total] = await Promise.all([
      orders(db).find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      orders(db).countDocuments(filter),
    ]);
    return ok({ items: items.map(toOrderSummary), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('list-my-orders error', err);
    return serverError();
  }
};
