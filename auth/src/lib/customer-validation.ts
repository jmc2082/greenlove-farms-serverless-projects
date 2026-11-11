import { ObjectId } from 'mongodb';
import { CustomerAddress } from '@greenlove/shared';

export const MAX_ADDRESSES = 10;
const US_STATE = /^[A-Z]{2}$/;
const US_ZIP = /^\d{5}(-\d{4})?$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Returns 10-digit US number, or null if it can't be one.
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return null;
}

/**
 * One address from the client. `at` prefixes error messages (e.g. "addresses[2]: ").
 * geo is never accepted from the client; it is set server-side by geocoding at checkout.
 * _id and isDefault are handled by the caller.
 */
export function parseAddress(raw: unknown, at = ''): { address?: CustomerAddress; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `${at}address must be an object` };
  const r = raw as Record<string, unknown>;
  const address: CustomerAddress = {
    label: str(r['label'], 40) || undefined,
    line1: str(r['line1'], 120),
    line2: str(r['line2'], 120) || undefined,
    city: str(r['city'], 60),
    state: str(r['state'], 2).toUpperCase(),
    zip: str(r['zip'], 10),
    deliveryInstructions: str(r['deliveryInstructions'], 500) || undefined,
  };
  if (!address.line1 || !address.city) return { error: `${at}line1 and city are required` };
  if (!US_STATE.test(address.state)) return { error: `${at}state must be a 2-letter code` };
  if (!US_ZIP.test(address.zip)) return { error: `${at}zip must be 12345 or 12345-6789` };
  if (r['isDefault'] !== undefined && typeof r['isDefault'] !== 'boolean') return { error: `${at}isDefault must be a boolean` };
  return { address };
}

/**
 * The full list sent to PUT /me. Addresses keep the id they were sent with (so a saved address can be
 * edited in place); new ones get a fresh id. Exactly one ends up default.
 */
export function parseAddresses(raw: unknown): { addresses?: CustomerAddress[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'addresses must be an array' };
  if (raw.length > MAX_ADDRESSES) return { error: `At most ${MAX_ADDRESSES} addresses` };

  const addresses: CustomerAddress[] = [];
  const seen = new Set<string>();
  for (const [i, a] of raw.entries()) {
    const { address, error } = parseAddress(a, `addresses[${i}]: `);
    if (error) return { error };
    const id = (a as Record<string, unknown>)['id'];
    const keep = typeof id === 'string' && ObjectId.isValid(id) && !seen.has(id);
    const _id = keep ? new ObjectId(id) : new ObjectId();
    seen.add(_id.toHexString());
    addresses.push({ ...address!, _id, isDefault: (a as Record<string, unknown>)['isDefault'] === true });
  }
  return { addresses: withOneDefault(addresses) };
}

// Keeps the first address marked default (or the first address, if none is) as the only default.
export function withOneDefault(addresses: CustomerAddress[]): CustomerAddress[] {
  const index = Math.max(0, addresses.findIndex((a) => a.isDefault));
  return addresses.map((a, i) => ({ ...a, isDefault: i === index }));
}
