import { Category, Product, ProductVariant } from '../types/catalog';

// null = not inventory-tracked (made/grown to order).
export const availableUnits = (v: ProductVariant): number | null =>
  v.inventory ? Math.max(0, v.inventory.onHand - v.inventory.held) : null;

// Public shape: hides internal fields (raw inventory counters, search terms, tax and ranking data).
export function toPublicProduct(p: Product) {
  return {
    id: p._id.toHexString(),
    slug: p.slug,
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription ?? '',
    label: p.label ?? null,
    storage: p.storage ?? '',
    badges: p.badges ?? [],
    category: p.category,
    fulfillmentClass: p.fulfillmentClass,
    fulfillmentProfile: p.fulfillmentProfile,
    images: p.images,
    variants: p.variants.map((v) => ({
      id: v._id.toHexString(),
      sku: v.sku,
      name: v.name,
      priceCents: v.priceCents,
      netWeight: v.netWeight ?? null,
      available: availableUnits(v),
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

export function toPublicCategory(c: Category, productCount: number) {
  return {
    slug: c.slug,
    name: c.name,
    blurb: c.blurb,
    image: c.image ?? null,
    sortOrder: c.sortOrder,
    productCount, // ACTIVE products; 0 lets the shop show "Coming soon"
  };
}

export function toAdminCategory({ _id, ...rest }: Category) {
  return { id: _id.toHexString(), ...rest };
}
