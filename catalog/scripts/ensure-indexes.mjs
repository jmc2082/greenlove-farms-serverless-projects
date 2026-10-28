// Usage: MONGODB_URI=... MONGODB_DB_NAME=greenlove_dev npm run indexes
import { MongoClient } from 'mongodb';

const { MONGODB_URI, MONGODB_DB_NAME } = process.env;
if (!MONGODB_URI || !MONGODB_DB_NAME) {
  console.error('MONGODB_URI and MONGODB_DB_NAME are required');
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
try {
  const products = client.db(MONGODB_DB_NAME).collection('products');
  await products.createIndexes([
    { key: { slug: 1 }, name: 'slug_unique', unique: true },
    { key: { status: 1, category: 1, name: 1 }, name: 'status_category_name' },
    { key: { status: 1, fulfillmentClass: 1, name: 1 }, name: 'status_fulfillment_name' },
    { key: { 'variants.sku': 1 }, name: 'variant_sku_unique', unique: true, sparse: true },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.products`);
} finally {
  await client.close();
}
