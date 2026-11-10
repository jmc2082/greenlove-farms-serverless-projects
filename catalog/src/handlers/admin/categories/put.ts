import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, conflict, serverError, Category, toAdminCategory } from '@greenlove/shared';
import { validateCategory, CATEGORY_SLUG } from '../../../lib/category-validation';
import { productImageFolder } from '../../../lib/cloudinary';

// Create or replace the category with this slug. Products refer to it by slug, so the slug can't change;
// to retire a category, set status HIDDEN.
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const slug = event.pathParameters?.['slug'] ?? '';
  if (!CATEGORY_SLUG.test(slug) || slug.length > 60) {
    return badRequest('slug must be lowercase letters, numbers and single hyphens (max 60)');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { category: fields, errors } = validateCategory(body, productImageFolder());
  if (errors) return badRequest('Validation failed', errors);

  try {
    const db = await getDb();
    const now = new Date();
    const result = await db.collection<Category>('categories').findOneAndUpdate(
      { slug },
      {
        $set: { ...fields!, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), slug, createdAt: now },
        ...(fields!.image ? {} : { $unset: { image: '' } }),
      },
      { upsert: true, returnDocument: 'after' }
    );
    return ok(toAdminCategory(result!));
  } catch (err) {
    // Two first-time saves of the same slug at once: the unique index rejects the second.
    if ((err as { code?: number }).code === 11000) return conflict('Category was just created — try again');
    console.error('admin-put-category error', err);
    return serverError();
  }
};
