import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, serverError } from '@greenlove/shared';
import { redemptions, toAdminRedemption } from '../../lib/view';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// GET /promotions/admin/{id}/redemptions?page=&limit= — orders that used the code, newest first.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid promotion ID');

  const q = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));
  const filter = { promotionId: new ObjectId(id) };

  try {
    const col = redemptions(await getDb());
    const [items, total, sums] = await Promise.all([
      col.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
      col.aggregate<{ discountCents: number; feeDiscountCents: number }>([
        { $match: filter },
        { $group: { _id: null, discountCents: { $sum: '$discountCents' }, feeDiscountCents: { $sum: '$feeDiscountCents' } } },
      ]).toArray(),
    ]);
    return ok({
      items: items.map(toAdminRedemption),
      page, limit, total, totalPages: Math.ceil(total / limit),
      totals: { discountCents: sums[0]?.discountCents ?? 0, feeDiscountCents: sums[0]?.feeDiscountCents ?? 0 },
    });
  } catch (err) {
    console.error('admin-list-redemptions error', err);
    return serverError();
  }
};
