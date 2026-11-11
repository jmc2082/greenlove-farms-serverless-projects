import { ObjectId } from 'mongodb';
import { Promotion } from './types/promotion';
import { FulfillmentClass } from './types/catalog';

export interface PromoLine {
  variantId: ObjectId;
  productId: ObjectId;
  category: string;
  fulfillmentClass: FulfillmentClass;
  lineTotalCents: number;
}

// The shopper's past use, for per-customer limits and first-order codes. Null while the shopper isn't
// known yet (a guest who hasn't entered an email); those checks then wait until they have.
export interface PromoHistory {
  customerRedemptions: number | null; // earlier orders with this code
  customerOrders: number | null;      // earlier orders of any kind
}

export type PromoResult =
  | { applied: true; lineDiscounts: Map<string, number>; waive: 'LOCAL_DELIVERY' | 'SHIP' | null } // variantId → cents off
  | { applied: false; reason: string };

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// Shopper-facing one-liner, e.g. "10% off selected items (up to $20), orders over $40".
export function promotionSummary(p: Pick<Promotion, 'type' | 'value' | 'appliesTo' | 'minSubtotalCents' | 'maxDiscountCents'>): string {
  const what =
    p.type === 'PERCENT' ? `${p.value}% off` :
    p.type === 'FIXED' ? `${money(p.value)} off` :
    p.type === 'FREE_DELIVERY' ? 'Free local delivery' : 'Free shipping';
  const scope = p.appliesTo.scope === 'ORDER' || p.type === 'FREE_DELIVERY' || p.type === 'FREE_SHIPPING' ? '' : ' selected items';
  const cap = p.type === 'PERCENT' && p.maxDiscountCents ? ` (up to ${money(p.maxDiscountCents)})` : '';
  const min = p.minSubtotalCents ? `, orders over ${money(p.minSubtotalCents)}` : '';
  return `${what}${scope}${cap}${min}`;
}

/** Whether the code can be used right now, ignoring the cart. Also the cart's quick check. */
export function promotionUsable(p: Promotion, now: Date): { ok: true } | { ok: false; reason: string } {
  if (p.status !== 'ACTIVE') return { ok: false, reason: 'This code isn’t valid.' };
  if (p.startsAt && now < p.startsAt) return { ok: false, reason: 'This code isn’t active yet.' };
  if (p.endsAt && now >= p.endsAt) return { ok: false, reason: 'This code has expired.' };
  if (p.usageLimit !== null && p.redemptionCount >= p.usageLimit) return { ok: false, reason: 'This code has been fully redeemed.' };
  return { ok: true };
}

const inScope = (p: Promotion, l: PromoLine) => {
  const { scope, ids } = p.appliesTo;
  if (scope === 'ORDER') return true;
  if (scope === 'CATEGORIES') return ids.includes(l.category);
  if (scope === 'PRODUCTS') return ids.includes(l.productId.toHexString());
  return ids.includes(l.fulfillmentClass);
};

/**
 * Applies a promotion to priced cart lines. The discount is spread over eligible lines in proportion to
 * their totals (largest remainder, so the cents add up exactly) and never exceeds a line's total.
 */
export function evaluatePromotion(
  p: Promotion,
  lines: PromoLine[],
  methods: { local: boolean; ship: boolean },
  history: PromoHistory,
  now: Date
): PromoResult {
  const usable = promotionUsable(p, now);
  if (!usable.ok) return { applied: false, reason: usable.reason };

  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  if (p.minSubtotalCents !== null && subtotal < p.minSubtotalCents) {
    return { applied: false, reason: `Add ${money(p.minSubtotalCents - subtotal)} more to use this code (minimum ${money(p.minSubtotalCents)}).` };
  }
  if (p.firstOrderOnly && history.customerOrders !== null && history.customerOrders > 0) {
    return { applied: false, reason: 'This code is for first orders only.' };
  }
  if (p.perCustomerLimit !== null && history.customerRedemptions !== null && history.customerRedemptions >= p.perCustomerLimit) {
    return { applied: false, reason: 'You’ve already used this code.' };
  }

  const eligible = lines.filter((l) => inScope(p, l));
  if (eligible.length === 0) return { applied: false, reason: 'This code doesn’t apply to the items in your cart.' };

  if (p.type === 'FREE_DELIVERY') {
    if (!methods.local) return { applied: false, reason: 'This code is for local delivery. Choose delivery to use it.' };
    return { applied: true, lineDiscounts: new Map(), waive: 'LOCAL_DELIVERY' };
  }
  if (p.type === 'FREE_SHIPPING') {
    if (!methods.ship) return { applied: false, reason: 'This code is for shipped orders. Choose shipping to use it.' };
    return { applied: true, lineDiscounts: new Map(), waive: 'SHIP' };
  }

  const eligibleTotal = eligible.reduce((s, l) => s + l.lineTotalCents, 0);
  let total = p.type === 'PERCENT' ? Math.round((eligibleTotal * p.value) / 100) : p.value;
  if (p.type === 'PERCENT' && p.maxDiscountCents !== null) total = Math.min(total, p.maxDiscountCents);
  total = Math.min(total, eligibleTotal);
  if (total <= 0) return { applied: false, reason: 'This code doesn’t apply to the items in your cart.' };

  const shares = eligible.map((l) => {
    const exact = (total * l.lineTotalCents) / eligibleTotal;
    return { id: l.variantId.toHexString(), cents: Math.floor(exact), rest: exact - Math.floor(exact), max: l.lineTotalCents };
  });
  let left = total - shares.reduce((s, x) => s + x.cents, 0);
  for (const x of [...shares].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    if (x.cents < x.max) { x.cents++; left--; }
  }
  return { applied: true, lineDiscounts: new Map(shares.map((x) => [x.id, x.cents])), waive: null };
}
