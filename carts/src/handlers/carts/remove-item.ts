import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, ok, badRequest, notFound, serverError } from '@greenlove/shared';
import { CartEvent, carts, cartScope } from '../../lib/cart-access';
import { removeCartItem } from '../../lib/cart-items';
import { toCartView } from '../../lib/cart-view';

// DELETE /carts/{cartId}/items/{variantId} | DELETE /me/cart/items/{variantId}
export const handler = async (event: CartEvent): Promise<APIGatewayProxyResultV2> => {
  const variantId = event.pathParameters?.['variantId'];
  if (!variantId || !ObjectId.isValid(variantId)) return badRequest('Invalid variant ID');

  try {
    const db = await getDb();
    const scope = await cartScope(db, event);
    if (!scope.ok) return scope.error;

    const result = await removeCartItem(db, scope.filter, new ObjectId(variantId));
    if (!result.ok) return notFound(result.message);

    return ok(await toCartView(db, await carts(db).findOne(scope.filter)));
  } catch (err) {
    console.error('remove-cart-item error', err);
    return serverError();
  }
};
