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
 * Confirmed 2026-11-11: $8.95 delivery (free from $40), $7.95 flat shipping, delivery from the Houston farm
 * (77070) to the ZIPs below, no pickup until partner locations are set. Tax codes: confirm with an accountant.
 * Override any of these with a `settings` document { _id: 'checkout', ... } (merged one level deep).
 */
export const DEFAULT_SETTINGS: CheckoutSettings = {
  localDelivery: {
    feeCents: 895,
    freeFromCents: 4000,
    zipPrefixes: [],
    // Within about 25 miles of the Houston farm (77070).
    zips: [
      '77070', '77065', '77066', '77068', '77069', '77014',          // NW Houston, Champions
      '77429', '77433', '77095',                                     // Cypress
      '77375', '77377',                                              // Tomball
      '77379', '77388', '77373', '77073', '77090',                   // Spring, North Houston
      '77064', '77040', '77041', '77086', '77088', '77091', '77067', // Greater NW and north-central Houston
      '77037', '77076', '77018', '77092',
    ],
    dateOptions: 4,
  },
  shipping: { flatCents: 795, freeFromCents: null, states: null },
  // None yet: pickup isn't offered until partner locations are added (each needs an id in PICKUP_LOCATION_IDS).
  pickupLocations: [],
  // Keys are the product TAX_CATEGORIES.
  taxCodes: {
    produce: 'txcd_40040019',    // Vegetables
    grocery: 'txcd_40040000',    // Food for Non-Immediate Consumption
    supplement: 'txcd_40090001', // Dietary Supplements
    skin_care: 'txcd_32050013',  // Skin Care Products
    soap: 'txcd_99999999',       // General - Tangible Goods
    prepared: 'txcd_40060003',   // Food for Immediate Consumption
    general: 'txcd_99999999',    // General - Tangible Goods
  },
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
