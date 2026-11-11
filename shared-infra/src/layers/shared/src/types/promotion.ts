import { ObjectId } from 'mongodb';

export const PROMOTION_TYPES = ['PERCENT', 'FIXED', 'FREE_DELIVERY', 'FREE_SHIPPING'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_SCOPES = ['ORDER', 'CATEGORIES', 'PRODUCTS', 'FULFILLMENT_CLASSES'] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];

export const PROMOTION_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

// Promo codes live in our database, not Stripe Coupons: the server applies them in the checkout quote,
// before tax, and records a redemption when the payment succeeds.
export interface Promotion {
  _id: ObjectId;
  code: string;        // uppercase, unique
  description: string; // staff-facing note
  type: PromotionType;
  value: number;       // PERCENT: 1–100; FIXED: cents; FREE_*: 0
  appliesTo: { scope: PromotionScope; ids: string[] }; // category slugs, product ids or fulfillment classes
  minSubtotalCents: number | null; // order subtotal before discounts
  maxDiscountCents: number | null; // cap for PERCENT
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;       // total redemptions
  perCustomerLimit: number | null; // per account, or per email for guests
  firstOrderOnly: boolean;
  status: PromotionStatus;
  redemptionCount: number;
  version: number;
  createdBy: { sub: string; email: string };
  updatedBy: { sub: string; email: string };
  createdAt: Date;
  updatedAt: Date;
}

// One per order that used a code. Unique on (promotionId, orderId).
export interface PromotionRedemption {
  _id: ObjectId;
  promotionId: ObjectId;
  code: string;
  orderId: ObjectId;
  orderNumber: string;
  customerId: ObjectId;
  email: string;
  discountCents: number;    // off items
  feeDiscountCents: number; // delivery or shipping waived
  createdAt: Date;
}

export const normalizePromoCode = (code: string) => code.trim().toUpperCase();
export const PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
