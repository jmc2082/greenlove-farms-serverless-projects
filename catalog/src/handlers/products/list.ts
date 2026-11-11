import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, serverError, Product, toPublicProduct } from '@greenlove/shared';
import { parseProductQuery, buildFilter, buildSearchStage, sortSpec, inStockMatch } from '../../lib/product-query';

// Shop grid and search results. With `q` the results come from Atlas Search, ranked by relevance unless a sort is given.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const { query, error } = parseProductQuery(event.queryStringParameters ?? {});
  if (error) return badRequest(error);
  const { page, limit, sort } = query!;
  const skip = (page - 1) * limit;

  try {
    const col = (await getDb()).collection<Product>('products');
    let items: Product[];
    let total: number;

    if (query!.q) {
      const sortStage = sort === 'relevance' ? [] : [{ $sort: sortSpec(sort) }];
      const [result] = await col
        .aggregate<{ items: Product[]; total: { n: number }[] }>([
          buildSearchStage(query!),
          ...inStockMatch(query!),
          { $facet: { items: [...sortStage, { $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } },
        ])
        .toArray();
      items = result?.items ?? [];
      total = result?.total[0]?.n ?? 0;
    } else {
      const filter = buildFilter(query!);
      [items, total] = await Promise.all([
        col.find(filter).sort(sortSpec(sort)).skip(skip).limit(limit).toArray(),
        col.countDocuments(filter),
      ]);
    }

    const now = new Date();
    return ok({
      items: items.map((p) => toPublicProduct(p, now)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sort,
    });
  } catch (err) {
    console.error('list-products error', err);
    return serverError();
  }
};
