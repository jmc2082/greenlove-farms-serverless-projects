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
    // Shop sorts: featured (default), newest, price.
    { key: { status: 1, featuredRank: -1, name: 1 }, name: 'status_featured' },
    { key: { status: 1, createdAt: -1 }, name: 'status_newest' },
    { key: { status: 1, priceFromCents: 1 }, name: 'status_price' },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.products`);

  // Products saved before priceFromCents existed get it now (the API also falls back to computing it).
  const backfill = await products.updateMany({ priceFromCents: { $exists: false } }, [
    { $set: { priceFromCents: { $min: '$variants.priceCents' } } },
  ]);
  if (backfill.modifiedCount) console.log(`Set priceFromCents on ${backfill.modifiedCount} products`);

  // Atlas Search index for q= and /products/suggest. Built in the background by Atlas; takes a minute or so.
  const searchDefinition = {
    mappings: {
      dynamic: false,
      fields: {
        name: [
          { type: 'string' },
          { type: 'autocomplete', tokenization: 'edgeGram', minGrams: 2, maxGrams: 15, foldDiacritics: true },
        ],
        shortDescription: { type: 'string' },
        description: { type: 'string' },
        searchTerms: { type: 'string' },
        status: { type: 'token' },
        category: { type: 'token' },
        fulfillmentClass: { type: 'token' },
        fulfillmentProfile: { type: 'document', fields: { methods: { type: 'token' } } },
        priceFromCents: { type: 'number' },
      },
    },
  };
  try {
    const existing = await products.listSearchIndexes('products_search').toArray();
    if (existing.length) await products.updateSearchIndex('products_search', searchDefinition);
    else await products.createSearchIndex({ name: 'products_search', definition: searchDefinition });
    console.log(`Search index products_search ${existing.length ? 'updated' : 'created'} (Atlas builds it in the background)`);
  } catch (err) {
    console.error(`Could not create the search index: ${err.message}`);
    console.error('Create it in Atlas → Search → Create Index (JSON editor), name "products_search", using the definition in this script.');
    process.exitCode = 1;
  }

  const categories = client.db(MONGODB_DB_NAME).collection('categories');
  await categories.createIndexes([
    { key: { slug: 1 }, name: 'slug_unique', unique: true },
    { key: { status: 1, sortOrder: 1, name: 1 }, name: 'status_sort_name' },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.categories`);
} finally {
  await client.close();
}
