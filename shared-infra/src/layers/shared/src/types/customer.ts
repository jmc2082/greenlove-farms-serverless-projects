import { ObjectId } from 'mongodb';

export interface CustomerAddress {
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
  createdAt: Date;
  updatedAt: Date;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
