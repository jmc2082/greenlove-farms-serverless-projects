import { createHash, randomUUID } from 'node:crypto';
import { Db, ObjectId } from 'mongodb';
import {
  Cart, Customer, FulfillmentClass, FulfillmentMethod, FULFILLMENT_METHODS, PICKUP_LOCATION_IDS, PickupLocationId,
  PostalAddress, Product, ProductImage, availableUnits, upcomingLocalDeliveries,
  Order, Promotion, PromotionRedemption, PromoLine, PROMO_CODE_PATTERN, evaluatePromotion, normalizePromoCode, promotionSummary,
} from '@greenlove/shared';
import { CheckoutSettings, PickupLocation, inDeliveryArea, taxCodeFor } from './settings';
import { FieldErrors, parseAddress, parseContact } from './input';
import { getStripe } from './stripe';

// ── Shapes ─────────────────────────────────────────────────────────────────────

export interface GroupSelection {
  fulfillmentClass: FulfillmentClass;
  method?: FulfillmentMethod;
  pickupLocation?: PickupLocationId;
  deliveryDate?: string; // YYYY-MM-DD, one of the group's dateOptions
}

// What the shopper chose; saved on the quote so /pay can re-price with exactly the same inputs.
export interface QuoteInputs {
  contact: { email: string; fullName: string; phone: string } | null;
  address: PostalAddress | null;
  savedAddressId: string | null;
  selections: GroupSelection[];
  promoCode: string | null;
}

export interface QuoteItem {
  productId: ObjectId;
  variantId: ObjectId;
  name: string;
  variantName: string;
  sku: string;
  image: ProductImage | null;
  qty: number;
  unitPriceCents: number;
  discountCents: number;
  lineTotalCents: number;
  taxCents: number;
  taxCode: string;
}

export interface QuoteGroup {
  key: string; // the fulfillment class, for now one group per class
  fulfillmentClass: FulfillmentClass;
  methodOptions: FulfillmentMethod[];
  method: FulfillmentMethod | null;
  pickupLocation: PickupLocation | null;
  address: PostalAddress | null;
  dateOptions: { date: string; orderBy: Date }[];
  deliveryDate: string | null;
  orderBy: Date | null;
  shipsWithinDays: number | null;
  items: QuoteItem[];
  subtotalCents: number;
  feeCents: number;
  taxCents: number | null;
}

export interface QuoteIssue {
  code:
    | 'CART_EMPTY' | 'ITEM_UNAVAILABLE' | 'NOT_ENOUGH_STOCK' | 'NOT_SOLD_ONLINE_YET'
    | 'METHOD_REQUIRED' | 'NO_COMMON_METHOD' | 'PICKUP_LOCATION_REQUIRED' | 'ADDRESS_REQUIRED'
    | 'OUTSIDE_DELIVERY_AREA' | 'SHIPPING_NOT_AVAILABLE' | 'DELIVERY_DATE_UNAVAILABLE'
    | 'CONTACT_REQUIRED' | 'TAX_UNAVAILABLE' | 'TOTAL_TOO_LOW';
  message: string;
  groupKey?: string;
  variantId?: string;
  available?: number;
}

export interface QuotePromotion {
  promotionId: ObjectId | null;
  code: string;
  applied: boolean;
  message: string | null; // why it doesn't apply
  summary: string | null; // e.g. "10% off, orders over $40"
  discountCents: number;    // off items
  feeDiscountCents: number; // delivery or shipping waived
}

export interface TaxCalc {
  groupKey: string;
  inputHash: string;
  calculationId: string;
  expiresAt: Date;
  itemTax: Record<string, number>; // variantId → cents
  feeTax: number;
}

export type QuoteStatus = 'OPEN' | 'PAYING' | 'PAID' | 'CANCELED';

export interface CheckoutQuote {
  _id: string;
  cartId: string;
  customerId: ObjectId | null;
  placedBy: 'GUEST' | 'CUSTOMER';
  inputs: QuoteInputs;
  contact: QuoteInputs['contact'];
  groups: QuoteGroup[];
  totals: {
    subtotalCents: number;
    discountCents: number;
    deliveryCents: number;
    shippingCents: number;
    taxCents: number | null;   // null until every group has an address to tax
    totalCents: number | null; // null while tax is unknown
  };
  issues: QuoteIssue[];
  // The code the shopper entered and what it did. A code that doesn't apply doesn't block payment;
  // the reason is shown under the code field.
  promotion: QuotePromotion | null;
  payable: boolean;
  requiresLabelAck: boolean; // cottage-food or TCS items: shopper must confirm they've read the labels
  tax: TaxCalc[];
  fingerprint: string; // changes whenever anything the shopper pays for changes
  status: QuoteStatus;
  attempt: number;
  paymentIntentId: string | null;
  holdId: string | null;
  clientSecretHash: string | null;
  payingLockUntil: Date | null;
  lastPaymentError: string | null;
  orderId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date; // TTL
}

export const quotes = (db: Db) => db.collection<CheckoutQuote>('checkoutQuotes');

const DAY_MS = 24 * 60 * 60 * 1000;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Parsing the request body ──────────────────────────────────────────────────

export function parseQuoteInputs(raw: Record<string, unknown>, errors: FieldErrors): QuoteInputs {
  const contact = raw['contact'] === undefined || raw['contact'] === null ? null : parseContact(raw['contact'], errors);
  const address = parseAddress(raw['address'], errors);
  const savedAddressId = typeof raw['savedAddressId'] === 'string' ? raw['savedAddressId'] : null;
  if (savedAddressId && !ObjectId.isValid(savedAddressId)) errors['savedAddressId'] = 'invalid';
  if (address && savedAddressId) errors['address'] = 'send address or savedAddressId, not both';

  const selections: GroupSelection[] = [];
  const rawGroups = raw['groups'] ?? [];
  if (!Array.isArray(rawGroups) || rawGroups.length > 4) {
    errors['groups'] = 'must be an array';
  } else {
    rawGroups.forEach((g: Record<string, unknown>, i) => {
      const sel: GroupSelection = { fulfillmentClass: g?.['fulfillmentClass'] as FulfillmentClass };
      if (typeof sel.fulfillmentClass !== 'string') errors[`groups[${i}].fulfillmentClass`] = 'required';
      if (g['method'] !== undefined && g['method'] !== null) {
        if (!FULFILLMENT_METHODS.includes(g['method'] as FulfillmentMethod)) errors[`groups[${i}].method`] = `one of ${FULFILLMENT_METHODS.join(', ')}`;
        else sel.method = g['method'] as FulfillmentMethod;
      }
      if (g['pickupLocation'] !== undefined && g['pickupLocation'] !== null) {
        if (!PICKUP_LOCATION_IDS.includes(g['pickupLocation'] as PickupLocationId)) errors[`groups[${i}].pickupLocation`] = `one of ${PICKUP_LOCATION_IDS.join(', ')}`;
        else sel.pickupLocation = g['pickupLocation'] as PickupLocationId;
      }
      if (g['deliveryDate'] !== undefined && g['deliveryDate'] !== null) {
        if (typeof g['deliveryDate'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g['deliveryDate'])) errors[`groups[${i}].deliveryDate`] = 'YYYY-MM-DD';
        else sel.deliveryDate = g['deliveryDate'];
      }
      selections.push(sel);
    });
  }
  let promoCode: string | null = null;
  if (raw['promoCode'] !== undefined && raw['promoCode'] !== null && raw['promoCode'] !== '') {
    promoCode = typeof raw['promoCode'] === 'string' ? normalizePromoCode(raw['promoCode']) : '';
    if (!PROMO_CODE_PATTERN.test(promoCode)) errors['promoCode'] = 'Enter a valid code';
  }
  return { contact, address, savedAddressId, selections, promoCode };
}

// ── Building the quote ────────────────────────────────────────────────────────

interface BuildContext {
  db: Db;
  settings: CheckoutSettings;
  cart: Cart;
  customer: Customer | null; // signed-in shopper
  inputs: QuoteInputs;
  now: Date;
}

const METHOD_ORDER: FulfillmentMethod[] = ['LOCAL_DELIVERY', 'PICKUP', 'SHIP'];

/**
 * Prices the cart from the catalog and returns a full quote (not yet saved). Never throws for shopper
 * mistakes: problems come back as `issues`, and the quote is payable only when there are none.
 */
export async function buildQuote(ctx: BuildContext): Promise<CheckoutQuote> {
  const { db, settings, cart, customer, inputs, now } = ctx;
  const issues: QuoteIssue[] = [];

  const products = await db
    .collection<Product>('products')
    .find({ _id: { $in: cart.items.map((i) => i.productId) } })
    .toArray();
  const byId = new Map(products.map((p) => [p._id.toHexString(), p]));

  // Lines → groups by fulfillment class.
  const groupLines = new Map<FulfillmentClass, { product: Product; item: QuoteItem }[]>();
  const promoLines: PromoLine[] = [];
  let requiresLabelAck = false;
  for (const line of cart.items) {
    const product = byId.get(line.productId.toHexString());
    const variant = product?.variants.find((v) => v._id.equals(line.variantId));
    const vid = line.variantId.toHexString();
    if (!product || !variant || product.status !== 'ACTIVE') {
      issues.push({ code: 'ITEM_UNAVAILABLE', message: 'An item in your cart is no longer available. Remove it to continue.', variantId: vid });
      continue;
    }
    if (product.fulfillmentClass !== 'STOCKED') {
      issues.push({ code: 'NOT_SOLD_ONLINE_YET', message: `${product.name} can't be ordered online yet.`, variantId: vid });
      continue;
    }
    const available = availableUnits(variant);
    if (available !== null && available < line.qty) {
      issues.push({
        code: 'NOT_ENOUGH_STOCK',
        message: available === 0 ? `${product.name} (${variant.name}) is sold out.` : `Only ${available} of ${product.name} (${variant.name}) left.`,
        variantId: vid,
        available,
      });
    }
    if (product.regulatoryClass === 'COTTAGE_FOOD' || product.regulatoryClass === 'TCS') requiresLabelAck = true;

    const lineTotal = variant.priceCents * line.qty;
    const item: QuoteItem = {
      productId: product._id,
      variantId: variant._id,
      name: product.name,
      variantName: variant.name,
      sku: variant.sku,
      image: product.images[0] ?? null,
      qty: line.qty,
      unitPriceCents: variant.priceCents,
      discountCents: 0, // promo codes come next
      lineTotalCents: lineTotal,
      taxCents: 0,
      taxCode: taxCodeFor(settings, product.taxCategory),
    };
    const list = groupLines.get(product.fulfillmentClass) ?? [];
    list.push({ product, item });
    promoLines.push({ variantId: variant._id, productId: product._id, category: product.category, fulfillmentClass: product.fulfillmentClass, lineTotalCents: lineTotal });
    groupLines.set(product.fulfillmentClass, list);
  }
  if (cart.items.length === 0) issues.push({ code: 'CART_EMPTY', message: 'Your cart is empty.' });

  // The shopper's address: typed in, or picked from their saved addresses.
  let address = inputs.address;
  if (!address && inputs.savedAddressId && customer) {
    const saved = customer.addresses.find((a) => a._id?.equals(inputs.savedAddressId!));
    if (saved) {
      address = { name: customer.fullName || undefined, line1: saved.line1, line2: saved.line2, city: saved.city, state: saved.state, zip: saved.zip, deliveryInstructions: saved.deliveryInstructions };
    }
  }

  const groups: QuoteGroup[] = [];
  for (const [fulfillmentClass, lines] of groupLines) {
    const key = fulfillmentClass;
    const sel = inputs.selections.find((s) => s.fulfillmentClass === fulfillmentClass);
    const methodOptions = METHOD_ORDER.filter((m) => lines.every((l) => l.product.fulfillmentProfile.methods.includes(m)));
    const handlingDays = Math.max(0, ...lines.map((l) => l.product.fulfillmentProfile.handlingDays ?? 0));
    const group: QuoteGroup = {
      key, fulfillmentClass, methodOptions, method: null, pickupLocation: null, address: null,
      dateOptions: [], deliveryDate: null, orderBy: null, shipsWithinDays: null,
      items: lines.map((l) => l.item),
      subtotalCents: lines.reduce((s, l) => s + l.item.lineTotalCents, 0),
      feeCents: 0, taxCents: null,
    };
    groups.push(group);

    if (methodOptions.length === 0) {
      issues.push({ code: 'NO_COMMON_METHOD', message: 'Some items here can only be shipped and others only delivered or picked up. Check out separately.', groupKey: key });
      continue;
    }
    if (!sel?.method) {
      issues.push({ code: 'METHOD_REQUIRED', message: 'Choose delivery, pickup or shipping.', groupKey: key });
      continue;
    }
    if (!methodOptions.includes(sel.method)) {
      issues.push({ code: 'METHOD_REQUIRED', message: 'That option isn’t available for these items. Choose another.', groupKey: key });
      continue;
    }
    group.method = sel.method;

    if (sel.method === 'PICKUP') {
      group.pickupLocation = settings.pickupLocations.find((p) => p.id === sel.pickupLocation) ?? null;
      if (!group.pickupLocation) issues.push({ code: 'PICKUP_LOCATION_REQUIRED', message: 'Choose a farm for pickup.', groupKey: key });
    } else if (!address) {
      issues.push({ code: 'ADDRESS_REQUIRED', message: sel.method === 'SHIP' ? 'Enter a shipping address.' : 'Enter a delivery address.', groupKey: key });
    } else if (sel.method === 'LOCAL_DELIVERY' && !inDeliveryArea(settings, address.zip)) {
      issues.push({ code: 'OUTSIDE_DELIVERY_AREA', message: 'That address is outside our delivery area. Choose pickup or shipping instead.', groupKey: key });
    } else if (sel.method === 'SHIP' && settings.shipping.states && !settings.shipping.states.includes(address.state)) {
      issues.push({ code: 'SHIPPING_NOT_AVAILABLE', message: `We don't ship to ${address.state} yet.`, groupKey: key });
    } else {
      group.address = address;
    }

    if (sel.method === 'SHIP') {
      group.shipsWithinDays = handlingDays;
    } else {
      group.dateOptions = upcomingLocalDeliveries(now, handlingDays, settings.localDelivery.dateOptions);
      const chosen = sel.deliveryDate ? group.dateOptions.find((d) => d.date === sel.deliveryDate) : group.dateOptions[0];
      if (!chosen) {
        issues.push({ code: 'DELIVERY_DATE_UNAVAILABLE', message: 'That date has passed its order cutoff. Choose another date.', groupKey: key });
      } else {
        group.deliveryDate = chosen.date;
        group.orderBy = chosen.orderBy;
      }
    }
  }

  // Contact: signed-in shoppers use their verified account email; guests type theirs (or set it on the cart).
  let contact = inputs.contact;
  if (customer) {
    contact = {
      email: customer.email,
      fullName: contact?.fullName || customer.fullName,
      phone: contact?.phone || customer.phone,
    };
  } else if (!contact && cart.contact?.email) {
    contact = { email: cart.contact.email, fullName: '', phone: '' };
  }
  if (!contact?.email || !contact.fullName) issues.push({ code: 'CONTACT_REQUIRED', message: 'Enter your name and email.' });

  // Promo code: applied before fees (free-delivery threshold uses the discounted subtotal) and before tax.
  const promotion = inputs.promoCode
    ? await applyPromotion(db, inputs.promoCode, promoLines, groups, customer?._id ?? null, contact?.email || null, now)
    : null;
  const discountCents = groups.reduce((s, g) => s + g.items.reduce((t, i) => t + i.discountCents, 0), 0);
  const afterDiscount = (g: QuoteGroup) => g.subtotalCents - g.items.reduce((t, i) => t + i.discountCents, 0);

  // Fees: local delivery is free once local items reach the threshold (charged once, on the first local
  // group); shipping is a flat rate per shipped group. A free-delivery or free-shipping code waives them.
  const localGroups = groups.filter((g) => g.method === 'LOCAL_DELIVERY');
  const localSubtotal = localGroups.reduce((s, g) => s + afterDiscount(g), 0);
  if (localGroups.length > 0 && localSubtotal < settings.localDelivery.freeFromCents) localGroups[0].feeCents = settings.localDelivery.feeCents;
  for (const g of groups.filter((x) => x.method === 'SHIP')) {
    const free = settings.shipping.freeFromCents !== null && afterDiscount(g) >= settings.shipping.freeFromCents;
    g.feeCents = free ? 0 : settings.shipping.flatCents;
  }
  if (promotion?.applied && promotion.waive) {
    for (const g of groups.filter((x) => x.method === promotion.waive)) {
      promotion.view.feeDiscountCents += g.feeCents;
      g.feeCents = 0;
    }
  }

  // Tax, once every group knows where the sale happens.
  const taxable = groups.length > 0 && groups.every((g) => g.method && (g.pickupLocation || g.address));
  const blocking = issues.some((i) => i.code === 'ITEM_UNAVAILABLE' || i.code === 'NOT_SOLD_ONLINE_YET' || i.code === 'CART_EMPTY');
  let tax: TaxCalc[] = [];
  if (taxable && !blocking) {
    try {
      tax = await calculateTax(db, cart._id, groups, now);
    } catch (err) {
      console.error('tax calculation failed', err);
      issues.push({ code: 'TAX_UNAVAILABLE', message: 'We couldn’t calculate sales tax just now. Please try again in a moment.' });
    }
  }
  for (const g of groups) {
    const calc = tax.find((t) => t.groupKey === g.key);
    if (!calc) continue;
    for (const item of g.items) item.taxCents = calc.itemTax[item.variantId.toHexString()] ?? 0;
    g.taxCents = g.items.reduce((s, i) => s + i.taxCents, 0) + calc.feeTax;
  }

  const subtotalCents = groups.reduce((s, g) => s + g.subtotalCents, 0);
  const deliveryCents = groups.filter((g) => g.method !== 'SHIP').reduce((s, g) => s + g.feeCents, 0);
  const shippingCents = groups.filter((g) => g.method === 'SHIP').reduce((s, g) => s + g.feeCents, 0);
  const taxCents = groups.length > 0 && groups.every((g) => g.taxCents !== null) ? groups.reduce((s, g) => s + g.taxCents!, 0) : null;
  const totals = {
    subtotalCents, discountCents, deliveryCents, shippingCents, taxCents,
    totalCents: taxCents === null ? null : subtotalCents - discountCents + deliveryCents + shippingCents + taxCents,
  };

  // Stripe's minimum charge is $0.50 (a large fixed discount could go below it).
  if (totals.totalCents !== null && totals.totalCents < 50) {
    issues.push({ code: 'TOTAL_TOO_LOW', message: 'Orders must be at least $0.50 after discounts.' });
  }

  // Empty fields are dropped: a saved quote reads back unset fields as null, and that must not count as a change.
  const fingerprint = sha256(JSON.stringify({
    contact,
    totals,
    promo: promotion ? [promotion.view.code, promotion.applied, promotion.view.feeDiscountCents] : null,
    groups: groups.map((g) => [g.key, g.method, g.pickupLocation?.id, g.address, g.deliveryDate, g.feeCents, g.taxCents,
      g.items.map((i) => [i.variantId.toHexString(), i.qty, i.unitPriceCents, i.discountCents, i.taxCents])]),
  }, (_key, value) => (value === null || value === undefined || value === '' ? undefined : value)));

  const id = randomUUID();
  return {
    _id: id,
    cartId: cart._id,
    customerId: customer?._id ?? null,
    placedBy: customer ? 'CUSTOMER' : 'GUEST',
    inputs,
    contact,
    groups,
    totals,
    issues,
    promotion: promotion?.view ?? null,
    payable: issues.length === 0 && totals.totalCents !== null,
    requiresLabelAck,
    tax,
    fingerprint,
    status: 'OPEN',
    attempt: 0,
    paymentIntentId: null,
    holdId: null,
    clientSecretHash: null,
    payingLockUntil: null,
    lastPaymentError: null,
    orderId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + DAY_MS),
  };
}

// ── Promo codes ───────────────────────────────────────────────────────────────

/**
 * Looks up the code and the shopper's history with it, applies it to the items (setting each item's
 * discountCents), and says which fee to waive. Per-customer and first-order limits use the account when
 * signed in, otherwise the email (checked once the guest has entered one).
 */
async function applyPromotion(
  db: Db,
  code: string,
  lines: PromoLine[],
  groups: QuoteGroup[],
  customerId: ObjectId | null,
  email: string | null,
  now: Date
): Promise<{ applied: boolean; waive: 'LOCAL_DELIVERY' | 'SHIP' | null; view: QuotePromotion }> {
  const notApplied = (message: string, p?: Promotion) => ({
    applied: false,
    waive: null,
    view: { promotionId: p?._id ?? null, code, applied: false, message, summary: p ? promotionSummary(p) : null, discountCents: 0, feeDiscountCents: 0 },
  });

  const promo = await db.collection<Promotion>('promotions').findOne({ code });
  if (!promo) return notApplied('This code isn’t valid.');

  const who = customerId ? { customerId } : email ? { email } : null;
  const [customerRedemptions, customerOrders] = who
    ? await Promise.all([
        db.collection<PromotionRedemption>('promotionRedemptions').countDocuments({ promotionId: promo._id, ...who }),
        promo.firstOrderOnly
          ? db.collection<Order>('orders').countDocuments(customerId ? { customerId } : { 'contact.email': email! })
          : Promise.resolve(0),
      ])
    : [null, null];

  const result = evaluatePromotion(
    promo,
    lines,
    { local: groups.some((g) => g.method === 'LOCAL_DELIVERY'), ship: groups.some((g) => g.method === 'SHIP') },
    { customerRedemptions, customerOrders },
    now
  );
  if (!result.applied) return notApplied(result.reason, promo);

  for (const g of groups) for (const i of g.items) i.discountCents = result.lineDiscounts.get(i.variantId.toHexString()) ?? 0;
  const discountCents = [...result.lineDiscounts.values()].reduce((s, c) => s + c, 0);
  return {
    applied: true,
    waive: result.waive,
    view: { promotionId: promo._id, code, applied: true, message: null, summary: promotionSummary(promo), discountCents, feeDiscountCents: 0 },
  };
}

// ── Stripe Tax ────────────────────────────────────────────────────────────────

const REUSE_MARGIN_MS = 60 * 60 * 1000;

const saleAddress = (g: QuoteGroup) => {
  const a: { line1?: string; line2?: string; city: string; state: string; zip: string } = g.pickupLocation ? g.pickupLocation.address : g.address!;
  return { line1: a.line1 || undefined, line2: a.line2 || undefined, city: a.city, state: a.state, postal_code: a.zip, country: 'US' };
};

/**
 * One Stripe Tax calculation per group (each group has one sale address). A calculation is reused when
 * an earlier quote for this cart sent identical inputs, so re-quoting (e.g. toggling a checkbox) doesn't
 * call Stripe again.
 */
async function calculateTax(db: Db, cartId: string, groups: QuoteGroup[], now: Date): Promise<TaxCalc[]> {
  const results: TaxCalc[] = [];
  for (const g of groups) {
    const request = {
      currency: 'usd',
      line_items: g.items.map((i) => ({
        amount: i.lineTotalCents - i.discountCents,
        quantity: i.qty,
        reference: i.variantId.toHexString(),
        tax_code: i.taxCode,
        tax_behavior: 'exclusive' as const,
      })),
      customer_details: { address: saleAddress(g), address_source: 'shipping' as const },
      ...(g.feeCents > 0 ? { shipping_cost: { amount: g.feeCents, tax_behavior: 'exclusive' as const } } : {}),
    };
    const inputHash = sha256(JSON.stringify(request));

    const previous = await quotes(db).findOne(
      { cartId, tax: { $elemMatch: { inputHash, expiresAt: { $gt: new Date(now.getTime() + REUSE_MARGIN_MS) } } } },
      { sort: { createdAt: -1 }, projection: { tax: 1 } }
    );
    const reused = previous?.tax.find((t) => t.inputHash === inputHash);
    if (reused) {
      results.push({ ...reused, groupKey: g.key });
      continue;
    }

    const stripe = await getStripe();
    const calc = await stripe.tax.calculations.create({ ...request, expand: ['line_items'] });
    const itemTax: Record<string, number> = {};
    for (const li of calc.line_items?.data ?? []) if (li.reference) itemTax[li.reference] = li.amount_tax;
    results.push({
      groupKey: g.key,
      inputHash,
      calculationId: calc.id!,
      expiresAt: new Date((calc.expires_at ?? now.getTime() / 1000 + 86400) * 1000),
      itemTax,
      feeTax: calc.shipping_cost?.amount_tax ?? 0,
    });
  }
  return results;
}

// ── Public view ───────────────────────────────────────────────────────────────

export function toQuoteView(q: CheckoutQuote, settings: CheckoutSettings) {
  const localSubtotal = q.groups
    .filter((g) => g.method === 'LOCAL_DELIVERY')
    .reduce((s, g) => s + g.subtotalCents - g.items.reduce((t, i) => t + i.discountCents, 0), 0);
  return {
    quoteId: q._id,
    payable: q.payable,
    issues: q.issues,
    requiresLabelAck: q.requiresLabelAck,
    contact: q.contact,
    groups: q.groups.map((g) => ({
      key: g.key,
      fulfillmentClass: g.fulfillmentClass,
      methodOptions: g.methodOptions,
      method: g.method,
      pickupLocation: g.pickupLocation ? { id: g.pickupLocation.id, name: g.pickupLocation.name } : null,
      pickupLocationOptions: g.methodOptions.includes('PICKUP') ? settings.pickupLocations.map((p) => ({ id: p.id, name: p.name })) : [],
      address: g.address,
      dateOptions: g.dateOptions.map((d) => ({ date: d.date, orderBy: d.orderBy.toISOString() })),
      deliveryDate: g.deliveryDate,
      orderBy: g.orderBy?.toISOString() ?? null,
      shipsWithinDays: g.shipsWithinDays,
      items: g.items.map((i) => ({
        productId: i.productId.toHexString(),
        variantId: i.variantId.toHexString(),
        name: i.name,
        variantName: i.variantName,
        sku: i.sku,
        image: i.image,
        qty: i.qty,
        unitPriceCents: i.unitPriceCents,
        discountCents: i.discountCents,
        lineTotalCents: i.lineTotalCents,
        taxCents: i.taxCents,
      })),
      subtotalCents: g.subtotalCents,
      feeCents: g.feeCents,
      taxCents: g.taxCents,
    })),
    totals: q.totals,
    promotion: q.promotion
      ? {
          code: q.promotion.code,
          applied: q.promotion.applied,
          message: q.promotion.message,
          summary: q.promotion.summary,
          discountCents: q.promotion.discountCents,
          feeDiscountCents: q.promotion.feeDiscountCents,
          savingsCents: q.promotion.discountCents + q.promotion.feeDiscountCents,
        }
      : null,
    // For the "$12 away from free local delivery" meter.
    freeDelivery: {
      thresholdCents: settings.localDelivery.freeFromCents,
      remainingCents: Math.max(0, settings.localDelivery.freeFromCents - localSubtotal),
    },
    createdAt: q.createdAt.toISOString(),
  };
}
