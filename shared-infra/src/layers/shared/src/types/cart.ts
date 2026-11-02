import { ObjectId } from 'mongodb';
import { ConsentRecord } from './customer';

export const CART_STATUSES = ['ACTIVE', 'CHECKING_OUT', 'CONVERTED', 'MERGED', 'ABANDONED'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export interface CartItem {
  productId: ObjectId;
  variantId: ObjectId;
  qty: number;
  addedAt: Date;
}

/**
 * Anonymous carts: _id is a random UUID held by the browser, customerId null.
 * Once linked to a customer the cart is only reachable through /me/cart.
 * Carts never reserve stock; checkout re-prices and holds inventory.
 */
export interface Cart {
  _id: string;
  customerId: ObjectId | null;
  items: CartItem[];
  status: CartStatus;
  // Guest contact captured at checkout step 1; used for abandoned-cart follow-up only if consent.granted.
  contact: { email: string; marketingEmail: ConsentRecord } | null;
  abandonedEmailSentAt: Date | null;
  mergedInto?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date; // TTL index
}

export const CART_LIMITS = { maxLines: 50, maxQty: 99 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const cartExpiry = (itemCount: number, from = new Date()) =>
  new Date(from.getTime() + (itemCount > 0 ? 30 : 7) * DAY_MS);
