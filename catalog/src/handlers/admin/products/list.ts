import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Filter } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, serverError, Product, PRODUCT_STATUSES, ProductStatus, toAdminProduct } from '@greenlove/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const q = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));

  const filter: Filter<Product> = {};
  if (q['status']) {
    if (!PRODUCT_STATUSES.includes(q['status'] as ProductStatus)) {
      return badRequest(`status must be one of: ${PRODUCT_STATUSES.join(', ')}`);
    }
    filter.status = q['status'] as ProductStatus;
  }
  if (q['category']) filter.category = q['category'];
  if (q['q']) {
    const re = new RegExp(escapeRegex(q['q'].slice(0, 60)), 'i');
    filter.$or = [{ name: re }, { 'variants.sku': re }];
  }

  try {
    const db = await getDb();
    const col = db.collection<Product>('products');
    const [items, total] = await Promise.all([
      col.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ]);

    return ok({ items: items.map(toAdminProduct), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('admin-list-products error', err);
    return serverError();
  }
};
