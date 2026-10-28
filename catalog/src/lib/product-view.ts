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

// Staff/Admin shape: everything, with ids as strings. Send `version` back on update.
export function toAdminProduct({ _id, variants, ...rest }: Product) {
  return {
    id: _id.toHexString(),
    ...rest,
    variants: variants.map(({ _id: vId, ...v }) => ({ id: vId.toHexString(), ...v })),
  };
}
