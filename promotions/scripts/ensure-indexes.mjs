// Usage: ./scripts/with-db.sh dev -- npm --prefix promotions run indexes
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB_NAME } = process.env;
if (!MONGODB_URI || !MONGODB_DB_NAME) {
  console.error('MONGODB_URI and MONGODB_DB_NAME are required');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
try {
  const db = client.db(MONGODB_DB_NAME);
  await db.collection('promotions').createIndexes([
    { key: { code: 1 }, name: 'code_unique', unique: true },
    { key: { status: 1, createdAt: -1 }, name: 'status_recent' },
  ]);
  await db.collection('promotionRedemptions').createIndexes([
    // One redemption per order: the checkout webhook relies on this to count each use once.
    { key: { promotionId: 1, orderId: 1 }, name: 'promotion_order_unique', unique: true },
    { key: { promotionId: 1, customerId: 1 }, name: 'promotion_customer' },
    { key: { promotionId: 1, email: 1 }, name: 'promotion_email' },
    { key: { promotionId: 1, createdAt: -1 }, name: 'promotion_recent' },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.promotions, promotionRedemptions`);
} finally {
  await client.close();
}
