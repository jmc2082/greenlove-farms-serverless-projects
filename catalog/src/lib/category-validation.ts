import { Category, CategoryStatus, CATEGORY_STATUSES, ProductImage } from '@greenlove/shared';

export type CategoryFields = Omit<Category, '_id' | 'slug' | 'createdAt' | 'updatedAt'>;

export const CATEGORY_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function validateCategory(
  raw: Record<string, unknown>,
  imageFolder: string
): { category?: CategoryFields; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = text(raw['name'], 80);
  if (!name) errors['name'] = 'required, 1-80 characters';

  const blurb = text(raw['blurb'], 500);

  const sortOrder = raw['sortOrder'] ?? 0;
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000) {
    errors['sortOrder'] = 'integer 0-1000 (lower shows first)';
  }

  const status = (raw['status'] ?? 'ACTIVE') as CategoryStatus;
  if (!CATEGORY_STATUSES.includes(status)) errors['status'] = `one of ${CATEGORY_STATUSES.join(', ')}`;

  let image: ProductImage | undefined;
  if (raw['image'] !== undefined && raw['image'] !== null) {
    const img = raw['image'] as Record<string, unknown>;
    const publicId = text(img?.['publicId'], 200);
    if (!publicId.startsWith(`${imageFolder}/`)) errors['image.publicId'] = `must be an upload in ${imageFolder}/`;
    else image = { publicId, alt: text(img['alt'], 200) || name };
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { category: { name, blurb, sortOrder: sortOrder as number, status, ...(image ? { image } : {}) } };
}
