import { ObjectId } from 'mongodb';

export const FULFILLMENT_CLASSES = ['STOCKED', 'MADE_TO_ORDER', 'GROW_TO_ORDER', 'CROP_RESERVATION'] as const;
export type FulfillmentClass = (typeof FULFILLMENT_CLASSES)[number];

export const FULFILLMENT_METHODS = ['SHIP', 'LOCAL_DELIVERY', 'PICKUP'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export const REGULATORY_CLASSES = ['COSMETIC', 'WHOLE_PRODUCE', 'COTTAGE_FOOD', 'TCS', 'OTHER'] as const;
export type RegulatoryClass = (typeof REGULATORY_CLASSES)[number];

// How a product is taxed. Checkout maps each to a Stripe tax code (checkout settings `taxCodes`).
//   produce:    microgreens, salad greens, lettuce heads, herbs (exempt in Texas)
//   grocery:    raw juices, juice cleanses, packaged food with a Nutrition Facts label (exempt in Texas)
//   supplement: anything labeled with a Supplement Facts panel (e.g. an elderberry syrup sold as a supplement)
//   skin_care:  body butter, sugar scrubs, lotions
//   soap:       bar soap
//   prepared:   ready-to-eat food (food-truck items, if ever sold online)
//   general:    anything else (taxed as general goods)
export const TAX_CATEGORIES = ['produce', 'grocery', 'supplement', 'skin_care', 'soap', 'prepared', 'general'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

// Small marketing tags shown on product cards. The frontend picks the style for each one.
export const PRODUCT_BADGES = ['NEW', 'BESTSELLER', 'LIMITED', 'SEASONAL', 'STAFF_PICK'] as const;
export type ProductBadge = (typeof PRODUCT_BADGES)[number];

export const CATEGORY_STATUSES = ['ACTIVE', 'HIDDEN'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

export interface FulfillmentProfile {
  methods: FulfillmentMethod[];
  handlingDays?: number;                       // STOCKED
  leadTimeDays?: { min: number; max: number }; // GROW_TO_ORDER
  perishable: boolean;
}

export interface ProductImage {
  publicId: string; // Cloudinary public ID
  alt: string;
}

export interface ProductVariant {
  _id: ObjectId;
  sku: string;
  name: string;
  priceCents: number;
  weightOz?: number;
  netWeight?: string; // label text, e.g. "4 oz (113 g)"
  inventory?: { onHand: number; held: number }; // STOCKED only
}

// Shown on the product page and confirmed at checkout before payment (Texas DSHS for cottage food).
export interface ProductLabel {
  ingredients: string;
  allergens: string[];
  statement?: string; // e.g. the cottage-food statement
}

export interface Product {
  _id: ObjectId;
  slug: string;
  name: string;
  description: string;
  // Products written before 2026-11-09 may lack the fields below until their next edit.
  shortDescription?: string; // one line for cards and meta descriptions
  searchTerms?: string[];    // synonyms for search, e.g. romaine → "lettuce", "salad"
  label?: ProductLabel;
  storage?: string;          // storage and shelf-life text
  featuredRank?: number;     // higher shows first in the "Featured" sort; 0 = not featured
  badges?: ProductBadge[];
  category: string;          // a categories.slug
  status: ProductStatus;
  fulfillmentClass: FulfillmentClass;
  fulfillmentProfile: FulfillmentProfile;
  regulatoryClass: RegulatoryClass;
  taxCategory: TaxCategory;
  images: ProductImage[];
  variants: ProductVariant[];
  priceFromCents?: number; // lowest variant price, kept in step on every write (for price sort and filters)
  // Bumped by every write that touches variants (edits, inventory, checkout holds) for optimistic concurrency.
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Category {
  _id: ObjectId;
  slug: string;
  name: string;
  blurb: string;
  image?: ProductImage;
  sortOrder: number; // lower shows first
  status: CategoryStatus;
  createdAt: Date;
  updatedAt: Date;
}
