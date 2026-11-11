import { Category, Product, ProductVariant } from '../types/catalog';
import { nextLocalDelivery } from '../delivery';

export const LOW_STOCK_THRESHOLD = 5;

export const AVAILABILITY_STATUSES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_YET_AVAILABLE'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

// null = not inventory-tracked (made/grown to order).
export const availableUnits = (v: ProductVariant): number | null =>
  v.inventory ? Math.max(0, v.inventory.onHand - v.inventory.held) : null;

export const priceFromCents = (p: Product): number =>
  p.priceFromCents ?? Math.min(...p.variants.map((v) => v.priceCents));

/**
 * What a shopper can expect right now. Phase 1 sells STOCKED products only; the other classes report
 * NOT_YET_AVAILABLE until their harvest and production schedules exist (Phase 2: readyFrom / readyTo).
 */
export function productAvailability(p: Product, now: Date = new Date()) {
  if (p.fulfillmentClass !== 'STOCKED') {
    return { status: 'NOT_YET_AVAILABLE' as AvailabilityStatus, remaining: null, nextDeliveryDate: null, orderBy: null, shipsWithinDays: null };
  }

  const remaining = p.variants.reduce((sum, v) => sum + (availableUnits(v) ?? 0), 0);
  const status: AvailabilityStatus = remaining === 0 ? 'OUT_OF_STOCK' : remaining <= LOW_STOCK_THRESHOLD ? 'LOW_STOCK' : 'IN_STOCK';
  const methods = p.fulfillmentProfile.methods;
  const handlingDays = p.fulfillmentProfile.handlingDays ?? 0;

  // Local delivery and pickup share the Tue/Thu schedule; the order needs `handlingDays` to prepare.
  const local = remaining > 0 && (methods.includes('LOCAL_DELIVERY') || methods.includes('PICKUP'))
    ? nextLocalDelivery(now, handlingDays)
    : null;

  return {
    status,
    remaining,
    nextDeliveryDate: local?.date ?? null,
    orderBy: local?.orderBy.toISOString() ?? null,
    shipsWithinDays: remaining > 0 && methods.includes('SHIP') ? handlingDays : null,
  };
}

// Public shape: hides internal fields (raw inventory counters, search terms, tax and ranking data).
export function toPublicProduct(p: Product, now: Date = new Date()) {
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
    priceFromCents: priceFromCents(p),
    availability: productAvailability(p, now),
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
