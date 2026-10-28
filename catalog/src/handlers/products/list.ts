import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Filter } from 'mongodb';
import { getDb, ok, badRequest, serverError, Product, FULFILLMENT_CLASSES, FulfillmentClass } from '@greenlove/shared';
import { toPublicProduct } from '../../lib/product-view';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const q = event.queryStringParameters ?? {};

  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));

  const filter: Filter<Product> = { status: 'ACTIVE' };
  if (q['category']) filter.category = q['category'];
  if (q['fulfillmentClass']) {
    if (!FULFILLMENT_CLASSES.includes(q['fulfillmentClass'] as FulfillmentClass)) {
      return badRequest(`fulfillmentClass must be one of: ${FULFILLMENT_CLASSES.join(', ')}`);
    }
    filter.fulfillmentClass = q['fulfillmentClass'] as FulfillmentClass;
  }

  try {
    const db = await getDb();
    const col = db.collection<Product>('products');

    const [items, total] = await Promise.all([
      col.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ]);

    return ok({
      items: items.map(toPublicProduct),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('list-products error', err);
    return serverError();
  }
};
