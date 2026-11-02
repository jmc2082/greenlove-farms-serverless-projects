import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, noContent, badRequest, notFound, serverError, Product } from '@greenlove/shared';
import { CartEvent, carts, cartScope, isSignedIn } from '../../lib/cart-access';

const VIEW_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// POST /carts/{cartId}/views | POST /me/views — body { productId }
// One row per (visitor, product) with a running count, so repeat views don't grow the collection.
export const handler = async (event: CartEvent): Promise<APIGatewayProxyResultV2> => {
  let body: { productId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  if (!body.productId || !ObjectId.isValid(body.productId)) return badRequest('productId is required');
  const productId = new ObjectId(body.productId);

  try {
    const db = await getDb();
    const scope = await cartScope(db, event);
    if (!scope.ok) return scope.error;

    let visitor: { customerId: ObjectId } | { cartId: string };
    if (isSignedIn(event)) {
      visitor = { customerId: scope.customerId! };
    } else {
      const cart = await carts(db).findOne(scope.filter, { projection: { _id: 1 } });
      if (!cart) return notFound('Cart not found');
      visitor = { cartId: cart._id };
    }

    const exists = await db.collection<Product>('products').countDocuments({ _id: productId, status: 'ACTIVE' }, { limit: 1 });
    if (!exists) return notFound('Product not found');

    const now = new Date();
    await db.collection('productViews').updateOne(
      { ...visitor, productId },
      {
        $set: { lastViewedAt: now, expiresAt: new Date(now.getTime() + VIEW_TTL_MS) },
        $setOnInsert: { firstViewedAt: now },
        $inc: { count: 1 },
      },
      { upsert: true }
    );
    return noContent();
  } catch (err) {
    console.error('record-view error', err);
    return serverError();
  }
};
