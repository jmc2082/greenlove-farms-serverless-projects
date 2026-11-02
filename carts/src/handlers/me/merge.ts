import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, CART_LIMITS, CartItem, cartExpiry } from '@greenlove/shared';
import { carts, getCustomerId, getOrCreateCustomerCart } from '../../lib/cart-access';
import { toCartView } from '../../lib/cart-view';

// POST /me/cart/merge — body { cartId }. Call right after login with the browser's anonymous cartId.
// If the customer has no active cart, the anonymous cart is simply claimed; otherwise its lines are folded in
// (quantities summed, capped) and the anonymous cart is marked MERGED. Idempotent.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  let body: { cartId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  if (!body.cartId || typeof body.cartId !== 'string') return badRequest('cartId is required');

  try {
    const db = await getDb();
    const customerId = await getCustomerId(db, event);
    if (!customerId) return notFound('Customer profile not found');

    const anon = await carts(db).findOne({ _id: body.cartId, customerId: null, status: 'ACTIVE' });
    const now = new Date();

    if (anon && !(await carts(db).findOne({ customerId, status: 'ACTIVE' }, { projection: { _id: 1 } }))) {
      try {
        const claimed = await carts(db).findOneAndUpdate(
          { _id: anon._id, customerId: null, status: 'ACTIVE' },
          { $set: { customerId, contact: null, updatedAt: now } },
          { returnDocument: 'after' }
        );
        if (claimed) return ok(await toCartView(db, claimed));
      } catch (err) {
        // A concurrent request created the customer's cart first (unique active-cart index) — fall through to merge.
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }

    const target = await getOrCreateCustomerCart(db, customerId);
    if (!anon || anon.items.length === 0) {
      if (anon) await carts(db).updateOne({ _id: anon._id }, { $set: { status: 'MERGED', mergedInto: target._id, updatedAt: now } });
      return ok(await toCartView(db, target));
    }

    const items: CartItem[] = target.items.map((i) => ({ ...i }));
    for (const incoming of anon.items) {
      const existing = items.find((i) => i.variantId.equals(incoming.variantId));
      if (existing) existing.qty = Math.min(CART_LIMITS.maxQty, existing.qty + incoming.qty);
      else if (items.length < CART_LIMITS.maxLines) items.push(incoming);
    }

    const merged = await carts(db).findOneAndUpdate(
      { _id: target._id },
      { $set: { items, updatedAt: now, expiresAt: cartExpiry(items.length, now) } },
      { returnDocument: 'after' }
    );
    await carts(db).updateOne({ _id: anon._id }, { $set: { status: 'MERGED', mergedInto: target._id, updatedAt: now } });

    return ok(await toCartView(db, merged));
  } catch (err) {
    console.error('merge-cart error', err);
    return serverError();
  }
};
