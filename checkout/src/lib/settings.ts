import { Db } from 'mongodb';
import { PickupLocationId } from '@greenlove/shared';

export interface PickupLocation {
  id: PickupLocationId;
  name: string;
  // Used as the sale address for sales tax on pickup orders. Only the ZIP is needed for a rate.
  address: { line1?: string; city: string; state: string; zip: string };
}

export interface CheckoutSettings {
  localDelivery: {
    feeCents: number;
    freeFromCents: number;  // local items' subtotal (after discounts) at or above this ship free
    zipPrefixes: string[];  // delivery area, until a radius check with geocoding replaces it
    zips: string[];         // extra single ZIPs inside the area
    dateOptions: number;    // how many upcoming Tue/Thu dates to offer
  };
  shipping: {
    flatCents: number;
    freeFromCents: number | null; // null = never free
    states: string[] | null;      // null = all U.S. states and DC
  };
  pickupLocations: PickupLocation[];
  // product.taxCategory → Stripe tax code. Unknown categories use 'general'.
  taxCodes: Record<string, string>;
  holdMinutes: number;  // how long stock is held after "Place order"
  quoteMinutes: number; // a quote must be paid within this long, or re-quoted
}

/**
 * Defaults match the website's static-data/site.ts deliveryRules ($8.95 delivery, free from $40).
 * Placeholders still to confirm: shipping rate, delivery-area ZIPs, farm addresses, tax codes per category.
 * Override any of these with a `settings` document { _id: 'checkout', ... } (merged one level deep).
 */
export const DEFAULT_SETTINGS: CheckoutSettings = {
  localDelivery: {
    feeCents: 895,
    freeFromCents: 4000,
    // Roughly Houston (770), the north suburbs incl. Conroe and Spring (773) and the west/northwest
    // suburbs incl. Cypress and Katy (774). Wider than 25 miles in places: narrow it before launch.
    zipPrefixes: ['770', '773', '774'],
    zips: [],
    dateOptions: 4,
  },
  shipping: { flatCents: 795, freeFromCents: null, states: null },
  pickupLocations: [
    { id: 'HOUSTON', name: 'Houston Farm', address: { city: 'Houston', state: 'TX', zip: '77070' } },
    { id: 'CONROE', name: 'Conroe Farm', address: { city: 'Conroe', state: 'TX', zip: '77301' } },
  ],
  taxCodes: { general: 'txcd_99999999' }, // General - Tangible Goods
  holdMinutes: 30,
  quoteMinutes: 30,
};

let cached: { at: number; value: CheckoutSettings } | null = null;
const CACHE_MS = 60_000;

export async function getSettings(db: Db): Promise<CheckoutSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const doc = await db.collection<{ _id: string } & Partial<CheckoutSettings>>('settings').findOne({ _id: 'checkout' });
  const value: CheckoutSettings = { ...DEFAULT_SETTINGS };
  if (doc) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof CheckoutSettings)[]) {
      const override = doc[key];
      if (override === undefined) continue;
      const base = DEFAULT_SETTINGS[key];
      (value as unknown as Record<string, unknown>)[key] =
        base && typeof base === 'object' && !Array.isArray(base) && typeof override === 'object' && !Array.isArray(override)
          ? { ...base, ...override }
          : override;
    }
  }
  cached = { at: Date.now(), value };
  return value;
}

export const taxCodeFor = (settings: CheckoutSettings, taxCategory: string) =>
  settings.taxCodes[taxCategory] ?? settings.taxCodes['general'] ?? 'txcd_99999999';

export function inDeliveryArea(settings: CheckoutSettings, zip: string): boolean {
  const zip5 = zip.slice(0, 5);
  return settings.localDelivery.zips.includes(zip5) || settings.localDelivery.zipPrefixes.some((p) => zip5.startsWith(p));
}
