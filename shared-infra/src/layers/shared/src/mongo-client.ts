import { MongoClient, Db, ServerApiVersion } from 'mongodb';
import { getParam } from './ssm-client';

let cachedClient: MongoClient | null = null;

// Deployed functions read the SecureString named by MONGODB_URI_PARAM; local `sam local` can set MONGODB_URI directly.
async function resolveUri(): Promise<string> {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const paramName = process.env.MONGODB_URI_PARAM;
  if (!paramName) throw new Error('MONGODB_URI or MONGODB_URI_PARAM must be set');
  return getParam(paramName, true);
}

export async function getDb(): Promise<Db> {
  if (cachedClient) {
    return cachedClient.db(process.env.MONGODB_DB_NAME);
  }

  const client = new MongoClient(await resolveUri(), {
    serverApi: {
      version: ServerApiVersion.v1,
      // Not strict: Atlas Search ($search, search index commands) is outside the Stable API and is refused in strict mode.
      strict: false,
      deprecationErrors: true,
    },
    maxPoolSize: 1,
    minPoolSize: 0,
    socketTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  await client.connect();
  cachedClient = client;
  return client.db(process.env.MONGODB_DB_NAME);
}
