import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, noContent, badRequest, notFound, conflict, serverError, Product } from '@greenlove/shared';
import { getCustomerId } from '../../lib/cart-access';

const MAX_WATCHLIST = 200;

// PUT /me/watchlist/{productId} — idempotent.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.['productId'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid product ID');
  const productId = new ObjectId(id);

  try {
    const db = await getDb();
    const customerId = await getCustomerId(db, event);
    if (!customerId) return notFound('Customer profile not found');

    const exists = await db.collection<Product>('products').countDocuments({ _id: productId, status: 'ACTIVE' }, { limit: 1 });
    if (!exists) return notFound('Product not found');

    const watchlist = db.collection('watchlist');
    if ((await watchlist.countDocuments({ customerId })) >= MAX_WATCHLIST) {
      return conflict(`Watchlist is limited to ${MAX_WATCHLIST} products`);
    }

    await watchlist.updateOne(
      { customerId, productId },
      { $setOnInsert: { customerId, productId, createdAt: new Date() } },
      { upsert: true }
    );
    return noContent();
  } catch (err) {
    console.error('add-watchlist error', err);
    return serverError();
  }
};
