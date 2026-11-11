import { ObjectId } from 'mongodb';

export interface CustomerAddress {
  _id?: ObjectId;      // set on every address saved since 2026-11-10; older ones get one on next read
  isDefault?: boolean; // exactly one saved address is the default
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  geo?: { lat: number; lng: number };
  deliveryInstructions?: string;
}

export interface ConsentRecord {
  granted: boolean;
  at: Date;
  source: 'checkout' | 'account' | 'admin';
}

// One document per email. Guests have cognitoSub = null until they sign up and confirm that email.
export interface Customer {
  _id: ObjectId;
  email: string;
  cognitoSub: string | null;
  fullName: string;
  phone: string;
  addresses: CustomerAddress[];
  consent: {
    marketingEmail: ConsentRecord | null;
    sms: ConsentRecord | null;
  };
  // Stripe Customer for saved cards; created the first time the shopper reaches payment while signed in.
  stripeCustomerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
