import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, serverError, Category, Product, toPublicCategory } from '@greenlove/shared';

// Visible categories in display order, each with its count of ACTIVE products.
export const handler = async (_event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const [categories, counts] = await Promise.all([
      db.collection<Category>('categories').find({ status: 'ACTIVE' }).sort({ sortOrder: 1, name: 1 }).toArray(),
      db
        .collection<Product>('products')
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: 'ACTIVE' } },
          { $group: { _id: '$category', n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const countBySlug = new Map(counts.map((c) => [c._id, c.n]));
    return ok({ items: categories.map((c) => toPublicCategory(c, countBySlug.get(c.slug) ?? 0)) });
  } catch (err) {
    console.error('list-categories error', err);
    return serverError();
  }
};
