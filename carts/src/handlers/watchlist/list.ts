import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, ok, notFound, serverError, Product, toPublicProduct } from '@greenlove/shared';
import { getCustomerId } from '../../lib/cart-access';

// GET /me/watchlist — newest first; archived/draft products are omitted.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const customerId = await getCustomerId(db, event);
    if (!customerId) return notFound('Customer profile not found');

    const entries = await db
      .collection<{ customerId: ObjectId; productId: ObjectId; createdAt: Date }>('watchlist')
      .find({ customerId })
      .sort({ createdAt: -1 })
      .toArray();

    const products = await db
      .collection<Product>('products')
      .find({ _id: { $in: entries.map((e) => e.productId) }, status: 'ACTIVE' })
      .toArray();
    const byId = new Map(products.map((p) => [p._id.toHexString(), p]));

    const items = entries
      .filter((e) => byId.has(e.productId.toHexString()))
      .map((e) => ({ addedAt: e.createdAt, product: toPublicProduct(byId.get(e.productId.toHexString())!) }));

    return ok({ items });
  } catch (err) {
    console.error('list-watchlist error', err);
    return serverError();
  }
};
