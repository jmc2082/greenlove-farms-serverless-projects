// Usage: ./scripts/with-db.sh dev -- npm --prefix orders run indexes
// The main orders indexes (order number, PaymentIntent, customer, delivery day) are created by checkout's script.
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB_NAME } = process.env;
if (!MONGODB_URI || !MONGODB_DB_NAME) {
  console.error('MONGODB_URI and MONGODB_DB_NAME are required');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
try {
  const db = client.db(MONGODB_DB_NAME);
  await db.collection('orders').createIndexes([
    // Guest tracking links.
    { key: { guestAccessTokenHash: 1 }, name: 'guest_token', partialFilterExpression: { guestAccessTokenHash: { $type: 'string' } } },
    // Lookup by email + order number.
    { key: { orderNumber: 1, 'contact.email': 1 }, name: 'number_email' },
    { key: { 'inventory.short': 1, createdAt: -1 }, name: 'inventory_short', partialFilterExpression: { 'inventory.short': true } },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.orders`);
} finally {
  await client.close();
}
