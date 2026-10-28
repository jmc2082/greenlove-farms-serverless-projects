import { Product } from '@greenlove/shared';

// Public shape: hides internal fields (Square IDs, raw inventory counters).
export function toPublicProduct(p: Product) {
  return {
    id: p._id.toHexString(),
    slug: p.slug,
    name: p.name,
    description: p.description,
    category: p.category,
    fulfillmentClass: p.fulfillmentClass,
    fulfillmentProfile: p.fulfillmentProfile,
    images: p.images,
    variants: p.variants.map((v) => ({
      id: v._id.toHexString(),
      sku: v.sku,
      name: v.name,
      priceCents: v.priceCents,
      available: v.inventory ? Math.max(0, v.inventory.onHand - v.inventory.held) : null,
    })),
  };
}
