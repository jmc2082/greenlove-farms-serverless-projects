import { Document, Filter, Sort } from 'mongodb';
import { Product, FULFILLMENT_CLASSES, FulfillmentClass, FULFILLMENT_METHODS, FulfillmentMethod } from '@greenlove/shared';

export const SEARCH_INDEX = 'products_search';

export const SORTS = ['relevance', 'featured', 'newest', 'price_asc', 'price_desc'] as const;
export type ProductSort = (typeof SORTS)[number];

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const MAX_PRICE_CENTS = 1_000_000;

export interface ProductQuery {
  q?: string;
  category?: string;
  fulfillmentClass?: FulfillmentClass;
  methods?: FulfillmentMethod[];
  minPriceCents?: number;
  maxPriceCents?: number;
  inStock: boolean;
  sort: ProductSort;
  page: number;
  limit: number;
}

const SORT_SPECS: Record<Exclude<ProductSort, 'relevance'>, Sort> = {
  featured: { featuredRank: -1, name: 1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  price_asc: { priceFromCents: 1, name: 1, _id: 1 },
  price_desc: { priceFromCents: -1, name: 1, _id: 1 },
};

const cents = (v: string | undefined): number | undefined | null => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PRICE_CENTS ? n : null;
};

// Shopper query string → validated query, or a message for a 400.
export function parseProductQuery(qs: Record<string, string | undefined>): { query?: ProductQuery; error?: string } {
  const page = Math.max(1, parseInt(qs['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(qs['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));

  const q = (qs['q'] ?? '').trim().slice(0, 100) || undefined;
  if (q && q.length < 2) return { error: 'q must be at least 2 characters' };

  const fulfillmentClass = qs['fulfillmentClass'] as FulfillmentClass | undefined;
  if (fulfillmentClass && !FULFILLMENT_CLASSES.includes(fulfillmentClass)) {
    return { error: `fulfillmentClass must be one of: ${FULFILLMENT_CLASSES.join(', ')}` };
  }

  let methods: FulfillmentMethod[] | undefined;
  if (qs['methods']) {
    methods = [...new Set(qs['methods'].split(',').map((m) => m.trim().toUpperCase()))] as FulfillmentMethod[];
    if (!methods.every((m) => FULFILLMENT_METHODS.includes(m))) {
      return { error: `methods must be a comma-separated list of: ${FULFILLMENT_METHODS.join(', ')}` };
    }
  }

  const minPriceCents = cents(qs['minPrice']);
  const maxPriceCents = cents(qs['maxPrice']);
  if (minPriceCents === null || maxPriceCents === null) return { error: 'minPrice and maxPrice are whole cents' };
  if (minPriceCents !== undefined && maxPriceCents !== undefined && minPriceCents > maxPriceCents) {
    return { error: 'minPrice must not be more than maxPrice' };
  }

  if (qs['inStock'] !== undefined && qs['inStock'] !== 'true' && qs['inStock'] !== 'false') {
    return { error: 'inStock must be true or false' };
  }

  const sort = (qs['sort'] ?? (q ? 'relevance' : 'featured')) as ProductSort;
  if (!SORTS.includes(sort)) return { error: `sort must be one of: ${SORTS.join(', ')}` };
  if (sort === 'relevance' && !q) return { error: 'sort=relevance needs q' };

  return {
    query: {
      q,
      category: qs['category'] || undefined,
      fulfillmentClass,
      methods,
      minPriceCents,
      maxPriceCents,
      inStock: qs['inStock'] === 'true',
      sort,
      page,
      limit,
    },
  };
}

// Some variant has stock left (onHand - held > 0). Untracked variants have no inventory and don't count.
const IN_STOCK_EXPR = {
  $anyElementTrue: {
    $map: {
      input: '$variants',
      in: { $gt: [{ $subtract: [{ $ifNull: ['$$this.inventory.onHand', 0] }, { $ifNull: ['$$this.inventory.held', 0] }] }, 0] },
    },
  },
};

const priceRange = (query: ProductQuery) =>
  query.minPriceCents !== undefined || query.maxPriceCents !== undefined
    ? {
        ...(query.minPriceCents !== undefined ? { $gte: query.minPriceCents } : {}),
        ...(query.maxPriceCents !== undefined ? { $lte: query.maxPriceCents } : {}),
      }
    : undefined;

// Plain listing (no q): an indexed find.
export function buildFilter(query: ProductQuery): Filter<Product> {
  const filter: Filter<Product> = { status: 'ACTIVE' };
  if (query.category) filter.category = query.category;
  if (query.fulfillmentClass) filter.fulfillmentClass = query.fulfillmentClass;
  if (query.methods) filter['fulfillmentProfile.methods'] = { $in: query.methods };
  const price = priceRange(query);
  if (price) filter.priceFromCents = price;
  if (query.inStock) filter.$expr = IN_STOCK_EXPR;
  return filter;
}

export const sortSpec = (sort: ProductSort): Sort => (sort === 'relevance' ? {} : SORT_SPECS[sort]);

/**
 * Atlas Search stage for `q`. Name matches rank highest, then shopper synonyms (searchTerms), then
 * descriptions; one typo is forgiven. Filters run inside the search so they use the search index.
 */
export function buildSearchStage(query: ProductQuery): Document {
  const filter: Document[] = [{ equals: { path: 'status', value: 'ACTIVE' } }];
  if (query.category) filter.push({ equals: { path: 'category', value: query.category } });
  if (query.fulfillmentClass) filter.push({ equals: { path: 'fulfillmentClass', value: query.fulfillmentClass } });
  if (query.methods) filter.push({ in: { path: 'fulfillmentProfile.methods', value: query.methods } });
  const price = priceRange(query);
  if (price) {
    filter.push({
      range: {
        path: 'priceFromCents',
        ...(price.$gte !== undefined ? { gte: price.$gte } : {}),
        ...(price.$lte !== undefined ? { lte: price.$lte } : {}),
      },
    });
  }

  return {
    $search: {
      index: SEARCH_INDEX,
      compound: {
        should: [
          { text: { query: query.q, path: 'name', fuzzy: { maxEdits: 1 }, score: { boost: { value: 3 } } } },
          { autocomplete: { query: query.q, path: 'name', score: { boost: { value: 2 } } } },
          { text: { query: query.q, path: 'searchTerms', fuzzy: { maxEdits: 1 }, score: { boost: { value: 2 } } } },
          { text: { query: query.q, path: ['shortDescription', 'description'] } },
        ],
        minimumShouldMatch: 1,
        filter,
      },
    },
  };
}

export const inStockMatch = (query: ProductQuery): Document[] => (query.inStock ? [{ $match: { $expr: IN_STOCK_EXPR } }] : []);
