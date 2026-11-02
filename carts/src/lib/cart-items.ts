import { Db, Filter, ObjectId } from 'mongodb';
import { Cart, Product, CART_LIMITS, cartExpiry, availableUnits } from '@greenlove/shared';
import { carts } from './cart-access';

export type ItemResult = { ok: true } | { ok: false; status: 400 | 404 | 409; message: string };

export async function removeCartItem(db: Db, scope: Filter<Cart>, variantId: ObjectId): Promise<ItemResult> {
  const now = new Date();
  const r = await carts(db).updateOne(
    { ...scope, status: 'ACTIVE' },
    { $pull: { items: { variantId } }, $set: { updatedAt: now, expiresAt: cartExpiry(1, now) } }
  );
  return r.matchedCount ? { ok: true } : { ok: false, status: 404, message: 'Cart not found or no longer active' };
}

/**
 * Sets one variant's quantity in an ACTIVE cart (qty 0 removes the line).
 * Validates against the live catalog but reserves nothing.
 */
export async function setCartItem(
  db: Db,
  scope: Filter<Cart>,
  productId: ObjectId,
  variantId: ObjectId,
  qty: number
): Promise<ItemResult> {
  if (qty === 0) return removeCartItem(db, scope, variantId);

  const filter: Filter<Cart> = { ...scope, status: 'ACTIVE' };
  const now = new Date();
  const touch = { updatedAt: now, expiresAt: cartExpiry(1, now) };

  const product = await db.collection<Product>('products').findOne({ _id: productId, status: 'ACTIVE' });
  const variant = product?.variants.find((v) => v._id.equals(variantId));
  if (!product || !variant) return { ok: false, status: 404, message: 'Product is not available' };

  const available = availableUnits(variant);
  if (available !== null && qty > available) {
    return { ok: false, status: 409, message: available === 0 ? 'Out of stock' : `Only ${available} available` };
  }

  // Existing line: update in place.
  const updated = await carts(db).updateOne(
    { ...filter, 'items.variantId': variantId },
    { $set: { 'items.$.qty': qty, ...touch } }
  );
  if (updated.matchedCount) return { ok: true };

  // New line: push only if not present and under the line cap (both checked atomically in the filter).
  const pushed = await carts(db).updateOne(
    { ...filter, 'items.variantId': { $ne: variantId }, [`items.${CART_LIMITS.maxLines - 1}`]: { $exists: false } },
    { $push: { items: { productId, variantId, qty, addedAt: now } }, $set: touch }
  );
  if (pushed.matchedCount) return { ok: true };

  const cart = await carts(db).findOne(filter, { projection: { items: 1 } });
  if (!cart) return { ok: false, status: 404, message: 'Cart not found or no longer active' };
  if (cart.items.length >= CART_LIMITS.maxLines) {
    return { ok: false, status: 409, message: `A cart can hold at most ${CART_LIMITS.maxLines} different items` };
  }
  // Lost a race with a concurrent add of the same variant: retry as an in-place update.
  await carts(db).updateOne({ ...filter, 'items.variantId': variantId }, { $set: { 'items.$.qty': qty, ...touch } });
  return { ok: true };
}

export function parseQty(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= CART_LIMITS.maxQty ? raw : null;
}
