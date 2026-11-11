// Usage: MONGODB_URI=... MONGODB_DB_NAME=greenlove_dev npm run indexes
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB_NAME } = process.env;
if (!MONGODB_URI || !MONGODB_DB_NAME) {
  console.error('MONGODB_URI and MONGODB_DB_NAME are required');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
try {
  const db = client.db(MONGODB_DB_NAME);
  await db.collection('carts').createIndexes([
    { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
    // At most one ACTIVE cart per customer (makes get-or-create safe under concurrency).
    { key: { customerId: 1 }, name: 'customer_active_unique', unique: true, partialFilterExpression: { status: 'ACTIVE', customerId: { $type: 'objectId' } } },
    // Abandoned-cart sweep: active carts with a consenting contact, idle since updatedAt.
    { key: { status: 1, 'contact.marketingEmail.granted': 1, updatedAt: 1 }, name: 'abandoned_sweep' },
  ]);
  await db.collection('productViews').createIndexes([
    { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
    { key: { cartId: 1, productId: 1 }, name: 'cart_product_unique', unique: true, partialFilterExpression: { cartId: { $type: 'string' } } },
    { key: { customerId: 1, productId: 1 }, name: 'customer_product_unique', unique: true, partialFilterExpression: { customerId: { $type: 'objectId' } } },
    // Recently viewed, newest first.
    { key: { cartId: 1, lastViewedAt: -1 }, name: 'cart_recent', partialFilterExpression: { cartId: { $type: 'string' } } },
    { key: { customerId: 1, lastViewedAt: -1 }, name: 'customer_recent', partialFilterExpression: { customerId: { $type: 'objectId' } } },
  ]);
  await db.collection('watchlist').createIndexes([
    { key: { customerId: 1, productId: 1 }, name: 'customer_product_unique', unique: true },
    { key: { customerId: 1, createdAt: -1 }, name: 'customer_created' },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.carts, productViews, watchlist`);
} finally {
  await client.close();
}
