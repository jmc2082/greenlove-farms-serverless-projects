import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, ok, badRequest, notFound, serverError, Product, toPublicProduct } from '@greenlove/shared';
import { CartEvent, carts, cartScope, isSignedIn } from '../../lib/cart-access';
import { productViews } from '../../lib/product-views';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
// Read a few extra rows so archived products and the excluded one can be dropped without coming up short.
const LOOKAHEAD = 10;

// GET /carts/{cartId}/views | GET /me/views — recently viewed, newest first; only products still for sale.
// ?exclude=<productId> leaves out the product being viewed (for a product page's "recently viewed" strip).
export const handler = async (event: CartEvent): Promise<APIGatewayProxyResultV2> => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(qs['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));
  const exclude = qs['exclude'];
  if (exclude !== undefined && !ObjectId.isValid(exclude)) return badRequest('exclude must be a product ID');

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

    const views = await productViews(db)
      .find({ ...visitor, ...(exclude ? { productId: { $ne: new ObjectId(exclude) } } : {}) })
      .sort({ lastViewedAt: -1 })
      .limit(limit + LOOKAHEAD)
      .toArray();

    const products = await db
      .collection<Product>('products')
      .find({ _id: { $in: views.map((v) => v.productId) }, status: 'ACTIVE' })
      .toArray();
    const byId = new Map(products.map((p) => [p._id.toHexString(), p]));

    const now = new Date();
    const items = views
      .filter((v) => byId.has(v.productId.toHexString()))
      .slice(0, limit)
      .map((v) => ({ viewedAt: v.lastViewedAt, product: toPublicProduct(byId.get(v.productId.toHexString())!, now) }));

    return ok({ items });
  } catch (err) {
    console.error('list-views error', err);
    return serverError();
  }
};
