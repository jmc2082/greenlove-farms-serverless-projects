import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, serverError, Category, Product, priceFromCents } from '@greenlove/shared';
import { SEARCH_INDEX } from '../../lib/product-query';

const MAX_PRODUCTS = 5;
const MAX_CATEGORIES = 3;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Search-as-you-type: a few products by name prefix, plus categories whose name contains the text.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const q = (event.queryStringParameters?.['q'] ?? '').trim().slice(0, 60);
  if (q.length < 2) return badRequest('q must be at least 2 characters');

  try {
    const db = await getDb();
    const [products, categories] = await Promise.all([
      db
        .collection<Product>('products')
        .aggregate<Product>([
          {
            $search: {
              index: SEARCH_INDEX,
              compound: {
                must: [{ autocomplete: { query: q, path: 'name', fuzzy: { maxEdits: 1, prefixLength: 1 } } }],
                filter: [{ equals: { path: 'status', value: 'ACTIVE' } }],
              },
            },
          },
          { $limit: MAX_PRODUCTS },
          { $project: { slug: 1, name: 1, images: { $slice: ['$images', 1] }, variants: 1, priceFromCents: 1 } },
        ])
        .toArray(),
      db
        .collection<Category>('categories')
        .find({ status: 'ACTIVE', name: { $regex: escapeRegex(q), $options: 'i' } })
        .sort({ sortOrder: 1, name: 1 })
        .limit(MAX_CATEGORIES)
        .project<Pick<Category, 'slug' | 'name'>>({ _id: 0, slug: 1, name: 1 })
        .toArray(),
    ]);

    return ok({
      products: products.map((p) => ({
        id: p._id.toHexString(),
        slug: p.slug,
        name: p.name,
        image: p.images[0] ?? null,
        priceFromCents: priceFromCents(p),
      })),
      categories,
    });
  } catch (err) {
    console.error('suggest-products error', err);
    return serverError();
  }
};
