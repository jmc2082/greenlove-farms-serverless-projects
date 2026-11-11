import { Db, ObjectId } from 'mongodb';
import { Product, availableUnits } from '@greenlove/shared';

export interface HoldLine {
  productId: ObjectId;
  variantId: ObjectId;
  qty: number;
  held: boolean; // true once `inventory.held` was raised for this line
}

/**
 * Stock set aside between "Place order" and the payment result. HELD → COMMITTED (paid: stock leaves
 * onHand) or RELEASED (abandoned or cancelled). Not a TTL collection: an expired hold must give its units
 * back, so the sweep function releases it instead.
 */
export interface CheckoutHold {
  _id: string; // `${quoteId}:${attempt}`
  quoteId: string;
  paymentIntentId: string | null;
  lines: HoldLine[];
  status: 'HELD' | 'COMMITTED' | 'RELEASED';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const holds = (db: Db) => db.collection<CheckoutHold>('checkoutHolds');
const products = (db: Db) => db.collection<Product>('products');

const MAX_ATTEMPTS = 4;

export type Shortage = { variantId: string; available: number };

/**
 * Raise `inventory.held` for every line. Each product is updated with an optimistic `version` check, so
 * two shoppers can't both take the last unit. All-or-nothing: on any shortage the lines already held are
 * released and the shortages returned.
 */
export async function placeHold(
  db: Db,
  id: string,
  quoteId: string,
  items: { productId: ObjectId; variantId: ObjectId; qty: number }[],
  expiresAt: Date
): Promise<{ ok: true } | { ok: false; shortages: Shortage[] }> {
  const now = new Date();
  // Written first, so a crash part-way still leaves a record the sweep can release.
  await holds(db).insertOne({
    _id: id, quoteId, paymentIntentId: null,
    lines: items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty, held: false })),
    status: 'HELD', expiresAt, createdAt: now, updatedAt: now,
  });

  const byProduct = new Map<string, typeof items>();
  for (const i of items) byProduct.set(i.productId.toHexString(), [...(byProduct.get(i.productId.toHexString()) ?? []), i]);

  const shortages: Shortage[] = [];
  for (const lines of byProduct.values()) {
    const result = await holdProduct(db, lines);
    if (result.length > 0) {
      shortages.push(...result);
      break;
    }
    await holds(db).updateOne(
      { _id: id },
      { $set: { 'lines.$[l].held': true, updatedAt: new Date() } },
      { arrayFilters: [{ 'l.productId': lines[0].productId }] }
    );
  }

  if (shortages.length > 0) {
    await releaseHold(db, id);
    return { ok: false, shortages };
  }
  return { ok: true };
}

async function holdProduct(db: Db, lines: { productId: ObjectId; variantId: ObjectId; qty: number }[]): Promise<Shortage[]> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const product = await products(db).findOne({ _id: lines[0].productId, status: 'ACTIVE' });
    if (!product) return lines.map((l) => ({ variantId: l.variantId.toHexString(), available: 0 }));

    const shortages: Shortage[] = [];
    for (const l of lines) {
      const v = product.variants.find((x) => x._id.equals(l.variantId));
      const available = v ? availableUnits(v) : 0;
      if (available !== null && available < l.qty) shortages.push({ variantId: l.variantId.toHexString(), available: available ?? 0 });
    }
    if (shortages.length > 0) return shortages;

    const inc: Record<string, number> = { version: 1 };
    lines.forEach((l, n) => (inc[`variants.$[v${n}].inventory.held`] = l.qty));
    const res = await products(db).updateOne(
      { _id: product._id, version: product.version },
      { $inc: inc, $set: { updatedAt: new Date() } },
      { arrayFilters: lines.map((l, n) => ({ [`v${n}._id`]: l.variantId, [`v${n}.inventory`]: { $exists: true } })) }
    );
    if (res.modifiedCount === 1) return [];
  }
  throw new Error('Could not hold stock: product kept changing');
}

// Give held units back. Safe to call twice: only a HELD hold changes, and only lines that were held.
export async function releaseHold(db: Db, id: string): Promise<boolean> {
  const hold = await holds(db).findOneAndUpdate(
    { _id: id, status: 'HELD' },
    { $set: { status: 'RELEASED', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!hold) return false;
  for (const l of hold.lines.filter((x) => x.held)) {
    await products(db).updateOne(
      { _id: l.productId },
      { $inc: { 'variants.$[v].inventory.held': -l.qty, version: 1 }, $set: { updatedAt: new Date() } },
      { arrayFilters: [{ 'v._id': l.variantId, 'v.inventory.held': { $gte: l.qty } }] }
    );
  }
  return true;
}

/**
 * Paid: units leave stock. With a live hold, held units become sold (onHand and held both drop). If the hold
 * already expired and was released, stock is taken straight from onHand; when there isn't enough, it's taken
 * anyway (the customer has paid) and `short` is returned so the order can be flagged for staff.
 */
export async function commitStock(
  db: Db,
  holdId: string | null,
  items: { productId: ObjectId; variantId: ObjectId; qty: number }[]
): Promise<{ short: boolean }> {
  const hold = holdId
    ? await holds(db).findOneAndUpdate({ _id: holdId, status: 'HELD' }, { $set: { status: 'COMMITTED', updatedAt: new Date() } }, { returnDocument: 'after' })
    : null;
  if (!hold && holdId) {
    const existing = await holds(db).findOne({ _id: holdId }, { projection: { status: 1 } });
    if (existing?.status === 'COMMITTED') return { short: false }; // already done by an earlier delivery of this event
  }

  let short = false;
  for (const item of items) {
    const line = hold?.lines.find((l) => l.variantId.equals(item.variantId) && l.held);
    if (line) {
      await products(db).updateOne(
        { _id: item.productId },
        { $inc: { 'variants.$[v].inventory.onHand': -item.qty, 'variants.$[v].inventory.held': -item.qty, version: 1 }, $set: { updatedAt: new Date() } },
        { arrayFilters: [{ 'v._id': item.variantId, 'v.inventory': { $exists: true } }] }
      );
      continue;
    }
    // No live hold for this line: take it only if free stock allows, otherwise take it anyway and flag.
    const product = await products(db).findOne({ _id: item.productId });
    const variant = product?.variants.find((v) => v._id.equals(item.variantId));
    if (!product || !variant?.inventory) continue;
    if ((availableUnits(variant) ?? 0) < item.qty) short = true;
    await products(db).updateOne(
      { _id: item.productId },
      { $inc: { 'variants.$[v].inventory.onHand': -item.qty, version: 1 }, $set: { updatedAt: new Date() } },
      { arrayFilters: [{ 'v._id': item.variantId }] }
    );
  }
  return { short };
}
