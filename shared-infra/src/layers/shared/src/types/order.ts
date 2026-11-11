import { ObjectId } from 'mongodb';
import { FulfillmentClass, FulfillmentMethod } from './catalog';

export const ORDER_STATUSES = ['PAID', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_GROUP_STATUSES = [
  'SCHEDULED', 'PREPARING', 'IN_PRODUCTION', 'READY', 'SHIPPED',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED',
] as const;
export type FulfillmentGroupStatus = (typeof FULFILLMENT_GROUP_STATUSES)[number];

// Pickup farms. Ids are stable; names and addresses live in the checkout settings.
export const PICKUP_LOCATION_IDS = ['HOUSTON', 'CONROE'] as const;
export type PickupLocationId = (typeof PICKUP_LOCATION_IDS)[number];

export interface PostalAddress {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string; // two-letter code
  zip: string;   // 12345 or 12345-6789
  deliveryInstructions?: string;
}

export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  deliveryCents: number; // local delivery fees
  shippingCents: number; // carrier shipping fees
  taxCents: number;
  totalCents: number;
}

// A snapshot of what was bought: later catalog edits never change an order.
export interface OrderItem {
  productId: ObjectId;
  variantId: ObjectId;
  name: string;
  variantName: string;
  sku: string;
  qty: number;
  unitPriceCents: number;
  discountCents: number;
  taxCents: number;
  lineTotalCents: number; // qty × unitPrice, before discount and tax
}

export interface FulfillmentGroup {
  _id: ObjectId;
  fulfillmentClass: FulfillmentClass;
  method: FulfillmentMethod;
  status: FulfillmentGroupStatus;
  items: OrderItem[];
  pickupLocation?: { id: PickupLocationId; name: string };
  address?: PostalAddress;          // LOCAL_DELIVERY and SHIP
  deliveryDate?: string;            // LOCAL_DELIVERY and PICKUP, YYYY-MM-DD in farm time
  shipsWithinDays?: number;         // SHIP
  feeCents: number;                 // delivery or shipping fee for this group
  taxCents: number;                 // tax on items and fee
  trackingNumber?: string;
  trackingUrl?: string;
  statusHistory: { status: FulfillmentGroupStatus; at: Date; by?: string }[];
}

export interface OrderRefund {
  refundId: string;   // Stripe refund id
  amountCents: number;
  reason: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  note: string;       // staff note
  restocked: { variantId: ObjectId; qty: number }[];
  taxReversalIds: string[];
  by: { sub: string; email: string };
  at: Date;
}

/**
 * One cart → one payment → one order → many fulfillment groups. Created by the Stripe webhook once the
 * payment succeeds, so every order here has been paid. customerId is set for signed-in shoppers and for
 * guests (a customers record with cognitoSub null, keyed by email), so signing up later links past orders.
 */
export interface Order {
  _id: ObjectId;
  orderNumber: string; // GLF-2026-000182
  customerId: ObjectId;
  placedBy: 'GUEST' | 'CUSTOMER';
  contact: { fullName: string; email: string; phone: string };
  status: OrderStatus;
  totals: OrderTotals;
  promotion?: { promotionId: ObjectId; code: string; discountCents: number; feeDiscountCents: number };
  payment: {
    provider: 'STRIPE';
    paymentIntentId: string;
    status: 'SUCCEEDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
    amountCents: number;
    currency: 'usd';
    method?: { type: string; brand?: string; last4?: string };
    refundedCents: number;
  };
  // Stripe Tax: one calculation per fulfillment group address; transactions record the sale for filing.
  tax: { calculationIds: string[]; transactionIds: string[] };
  fulfillmentGroups: FulfillmentGroup[];
  quoteId: string;
  cartId: string;
  // Stock leaves inventory once per order (committedAt). short: paid after its hold expired and stock ran
  // out in the meantime, so staff should review.
  inventory: { committedAt: Date | null; short: boolean };
  refunds?: OrderRefund[];
  guestAccessTokenHash: string | null; // sha256 of the tracking-link token, set when the link is emailed
  notifications: { confirmationSentAt: Date | null };
  createdAt: Date;
  updatedAt: Date;
}
