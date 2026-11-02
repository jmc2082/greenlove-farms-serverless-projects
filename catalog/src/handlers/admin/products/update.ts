import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, notFound, conflict, serverError, Product, toAdminProduct } from '@greenlove/shared';
import { validateProduct, toEditableInput } from '../../../lib/product-validation';
import { productImageFolder } from '../../../lib/cloudinary';

// Partial update: provided fields are merged over the current product and the result is re-validated as a whole.
// `version` (from the last read) is required so concurrent edits / stock changes are never silently overwritten.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid product ID');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { version, ...changes } = body;
  if (typeof version !== 'number') return badRequest('version is required (from the last read of this product)');

  try {
    const db = await getDb();
    const col = db.collection<Product>('products');

    const current = await col.findOne({ _id: new ObjectId(id) });
    if (!current) return notFound('Product not found');
    if (current.version !== version) return conflict('Product was changed by someone else — reload and try again');

    const { product: fields, errors } = validateProduct(
      { ...toEditableInput(current), ...changes },
      productImageFolder(),
      current.variants
    );
    if (errors) return badRequest('Validation failed', errors);

    const result = await col.findOneAndUpdate(
      { _id: current._id, version },
      { $set: { ...fields!, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after' }
    );
    if (!result) return conflict('Product was changed by someone else — reload and try again');

    return ok(toAdminProduct(result));
  } catch (err) {
    // Duplicate key. Checked by code, not instanceof: the driver class may come from another module copy.
    if ((err as { code?: number }).code === 11000) {
      return conflict('A product with that slug or SKU already exists');
    }
    console.error('admin-update-product error', err);
    return serverError();
  }
};
