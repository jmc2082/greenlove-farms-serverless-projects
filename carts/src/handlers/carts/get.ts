import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, notFound, serverError } from '@greenlove/shared';
import { CartEvent, carts, cartScope, isSignedIn } from '../../lib/cart-access';
import { toCartView } from '../../lib/cart-view';

// GET /carts/{cartId} | GET /me/cart
// Anonymous carts are returned in any status so the browser can tell a CONVERTED/MERGED cart and drop its id.
export const handler = async (event: CartEvent): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const scope = await cartScope(db, event);
    if (!scope.ok) return scope.error;

    const cart = await carts(db).findOne(scope.filter);
    if (!cart && !isSignedIn(event)) return notFound('Cart not found');

    // A signed-in customer without a cart yet gets an empty view; one is created on first add.
    return ok(await toCartView(db, cart));
  } catch (err) {
    console.error('get-cart error', err);
    return serverError();
  }
};
