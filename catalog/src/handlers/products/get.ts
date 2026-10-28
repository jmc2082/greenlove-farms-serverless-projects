import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, Product } from '@greenlove/shared';
import { toPublicProduct } from '../../lib/product-view';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const slug = event.pathParameters?.['slug'];
  if (!slug) return badRequest('Missing product slug');

  try {
    const db = await getDb();
    const product = await db.collection<Product>('products').findOne({ slug, status: 'ACTIVE' });
    if (!product) return notFound('Product not found');
    return ok(toPublicProduct(product));
  } catch (err) {
    console.error('get-product error', err);
    return serverError();
  }
};
