import { ObjectId } from 'mongodb';

export const FULFILLMENT_CLASSES = ['STOCKED', 'MADE_TO_ORDER', 'GROW_TO_ORDER', 'CROP_RESERVATION'] as const;
export type FulfillmentClass = (typeof FULFILLMENT_CLASSES)[number];

export const FULFILLMENT_METHODS = ['SHIP', 'LOCAL_DELIVERY', 'PICKUP'] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

export const REGULATORY_CLASSES = ['COSMETIC', 'WHOLE_PRODUCE', 'COTTAGE_FOOD', 'TCS', 'OTHER'] as const;
export type RegulatoryClass = (typeof REGULATORY_CLASSES)[number];

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

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
  inventory?: { onHand: number; held: number }; // STOCKED only
  squareVariationId?: string;
}

export interface Product {
  _id: ObjectId;
  slug: string;
  name: string;
  description: string;
  category: string;
  status: ProductStatus;
  fulfillmentClass: FulfillmentClass;
  fulfillmentProfile: FulfillmentProfile;
  regulatoryClass: RegulatoryClass;
  taxCategory: string;
  images: ProductImage[];
  variants: ProductVariant[];
  squareItemId?: string;
  // Bumped by every write that touches variants (edits, inventory, checkout holds) for optimistic concurrency.
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
