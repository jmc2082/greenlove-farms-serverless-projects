import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, created, serverError } from '@greenlove/shared';
import { carts, newCart } from '../../lib/cart-access';
import { toCartView } from '../../lib/cart-view';

// Anonymous cart. The browser keeps the returned cartId; signed-in shoppers use /me/cart instead.
export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const cart = newCart(null);
    await carts(db).insertOne(cart);
    return created(await toCartView(db, cart));
  } catch (err) {
    console.error('create-cart error', err);
    return serverError();
  }
};
