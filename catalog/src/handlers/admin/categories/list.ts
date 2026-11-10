import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, isStaff, ok, forbidden, serverError, Category, toAdminCategory } from '@greenlove/shared';

// Every category, hidden ones included.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  try {
    const db = await getDb();
    const items = await db.collection<Category>('categories').find({}).sort({ sortOrder: 1, name: 1 }).toArray();
    return ok({ items: items.map(toAdminCategory) });
  } catch (err) {
    console.error('admin-list-categories error', err);
    return serverError();
  }
};
