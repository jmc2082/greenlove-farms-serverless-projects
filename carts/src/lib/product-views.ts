import { Db, ObjectId, AnyBulkWriteOperation } from 'mongodb';

// One row per (visitor, product). A visitor is either an anonymous cart (cartId) or a customer (customerId).
export interface ProductView {
  _id: ObjectId;
  cartId?: string;
  customerId?: ObjectId;
  productId: ObjectId;
  count: number;
  firstViewedAt: Date;
  lastViewedAt: Date;
  expiresAt: Date;
}

export const productViews = (db: Db) => db.collection<ProductView>('productViews');

/**
 * Moves an anonymous cart's views onto the customer at login, so "recently viewed" survives signing in.
 * Products seen both ways keep the latest view time and the summed count. Safe to repeat.
 */
export async function mergeViews(db: Db, cartId: string, customerId: ObjectId): Promise<void> {
  const anonViews = await productViews(db).find({ cartId }).toArray();
  if (anonViews.length === 0) return;

  const ops: AnyBulkWriteOperation<ProductView>[] = anonViews.map((v) => ({
    updateOne: {
      filter: { customerId, productId: v.productId },
      update: {
        $max: { lastViewedAt: v.lastViewedAt, expiresAt: v.expiresAt },
        $min: { firstViewedAt: v.firstViewedAt },
        $inc: { count: v.count },
      },
      upsert: true,
    },
  }));
  await productViews(db).bulkWrite(ops, { ordered: false });
  await productViews(db).deleteMany({ _id: { $in: anonViews.map((v) => v._id) } });
}
