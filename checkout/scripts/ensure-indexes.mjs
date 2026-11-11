// Usage: ../scripts/with-db.sh dev -- npm run indexes
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB_NAME } = process.env;
if (!MONGODB_URI || !MONGODB_DB_NAME) {
  console.error('MONGODB_URI and MONGODB_DB_NAME are required');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
try {
  const db = client.db(MONGODB_DB_NAME);
  await db.collection('checkoutQuotes').createIndexes([
    { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
    { key: { paymentIntentId: 1 }, name: 'payment_intent', partialFilterExpression: { paymentIntentId: { $type: 'string' } } },
    // Reusing an earlier Stripe Tax calculation for the same cart and inputs.
    { key: { cartId: 1, 'tax.inputHash': 1 }, name: 'cart_tax_input' },
  ]);
  await db.collection('checkoutHolds').createIndexes([
    // The sweep: expired holds still HELD. Not a TTL index: expired holds must give their stock back first.
    { key: { status: 1, expiresAt: 1 }, name: 'status_expires' },
  ]);
  await db.collection('orders').createIndexes([
    { key: { orderNumber: 1 }, name: 'order_number_unique', unique: true },
    { key: { 'payment.paymentIntentId': 1 }, name: 'payment_intent_unique', unique: true },
    { key: { customerId: 1, createdAt: -1 }, name: 'customer_recent' },
    { key: { 'contact.email': 1, createdAt: -1 }, name: 'email_recent' },
    { key: { 'fulfillmentGroups.deliveryDate': 1, 'fulfillmentGroups.method': 1 }, name: 'delivery_day' },
    { key: { status: 1, createdAt: -1 }, name: 'status_recent' },
  ]);
  await db.collection('webhookEvents').createIndexes([
    { key: { expiresAt: 1 }, name: 'expires_ttl', expireAfterSeconds: 0 },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.checkoutQuotes, checkoutHolds, orders, webhookEvents`);
} finally {
  await client.close();
}
