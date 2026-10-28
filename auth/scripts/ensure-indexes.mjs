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
  await db.collection('customers').createIndexes([
    { key: { email: 1 }, name: 'email_unique', unique: true },
    // Guests have cognitoSub: null, so uniqueness applies only to linked accounts.
    { key: { cognitoSub: 1 }, name: 'cognito_sub_unique', unique: true, partialFilterExpression: { cognitoSub: { $type: 'string' } } },
  ]);
  await db.collection('adminAuditLog').createIndexes([
    { key: { createdAt: -1 }, name: 'created_desc' },
    { key: { targetEmail: 1, createdAt: -1 }, name: 'target_created' },
  ]);
  console.log(`Indexes ensured on ${MONGODB_DB_NAME}.customers, adminAuditLog`);
} finally {
  await client.close();
}
