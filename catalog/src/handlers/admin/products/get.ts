import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, notFound, serverError, Product } from '@greenlove/shared';
import { toAdminProduct } from '../../../lib/product-view';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid product ID');

  try {
    const db = await getDb();
    const product = await db.collection<Product>('products').findOne({ _id: new ObjectId(id) });
    if (!product) return notFound('Product not found');
    return ok(toAdminProduct(product));
  } catch (err) {
    console.error('admin-get-product error', err);
    return serverError();
  }
};
