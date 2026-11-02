import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, ok, badRequest, notFound, conflict, serverError, CART_LIMITS } from '@greenlove/shared';
import { CartEvent, carts, cartScope, getOrCreateCustomerCart } from '../../lib/cart-access';
import { setCartItem, parseQty } from '../../lib/cart-items';
import { toCartView } from '../../lib/cart-view';

// PUT /carts/{cartId}/items | PUT /me/cart/items — body { productId, variantId, qty } (qty 0 removes)
export const handler = async (event: CartEvent): Promise<APIGatewayProxyResultV2> => {
  let body: { productId?: string; variantId?: string; qty?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { productId, variantId } = body;
  if (!productId || !ObjectId.isValid(productId)) return badRequest('productId is required');
  if (!variantId || !ObjectId.isValid(variantId)) return badRequest('variantId is required');
  const qty = parseQty(body.qty);
  if (qty === null) return badRequest(`qty must be an integer from 0 to ${CART_LIMITS.maxQty}`);

  try {
    const db = await getDb();
    const scope = await cartScope(db, event);
    if (!scope.ok) return scope.error;

    const filter = scope.customerId ? { _id: (await getOrCreateCustomerCart(db, scope.customerId))._id } : scope.filter;

    const result = await setCartItem(db, filter, new ObjectId(productId), new ObjectId(variantId), qty);
    if (!result.ok) return result.status === 409 ? conflict(result.message) : result.status === 404 ? notFound(result.message) : badRequest(result.message);

    return ok(await toCartView(db, await carts(db).findOne(filter)));
  } catch (err) {
    console.error('set-cart-item error', err);
    return serverError();
  }
};
