import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, noContent, badRequest, notFound, serverError } from '@greenlove/shared';
import { getCustomerId } from '../../lib/cart-access';

// DELETE /me/watchlist/{productId} — idempotent.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.['productId'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid product ID');

  try {
    const db = await getDb();
    const customerId = await getCustomerId(db, event);
    if (!customerId) return notFound('Customer profile not found');

    await db.collection('watchlist').deleteOne({ customerId, productId: new ObjectId(id) });
    return noContent();
  } catch (err) {
    console.error('remove-watchlist error', err);
    return serverError();
  }
};
