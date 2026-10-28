import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, created, badRequest, forbidden, conflict, serverError, Product } from '@greenlove/shared';
import { validateProduct } from '../../../lib/product-validation';
import { productImageFolder } from '../../../lib/cloudinary';
import { toAdminProduct } from '../../../lib/product-view';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { product: fields, errors } = validateProduct(body, productImageFolder());
  if (errors) return badRequest('Validation failed', errors);

  const now = new Date();
  const product: Product = { _id: new ObjectId(), ...fields!, version: 1, createdAt: now, updatedAt: now };

  try {
    const db = await getDb();
    await db.collection<Product>('products').insertOne(product);
    return created(toAdminProduct(product));
  } catch (err) {
    // Duplicate key. Checked by code, not instanceof: the driver class may come from another module copy.
    if ((err as { code?: number }).code === 11000) {
      return conflict('A product with that slug or SKU already exists');
    }
    console.error('admin-create-product error', err);
    return serverError();
  }
};
