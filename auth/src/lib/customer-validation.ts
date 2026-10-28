import { CustomerAddress } from '@greenlove/shared';

const MAX_ADDRESSES = 10;
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

// geo is never accepted from the client; it is set server-side by geocoding at checkout.
export function parseAddresses(raw: unknown): { addresses?: CustomerAddress[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'addresses must be an array' };
  if (raw.length > MAX_ADDRESSES) return { error: `At most ${MAX_ADDRESSES} addresses` };

  const addresses: CustomerAddress[] = [];
  for (const [i, a] of raw.entries()) {
    if (typeof a !== 'object' || a === null) return { error: `addresses[${i}] must be an object` };
    const r = a as Record<string, unknown>;
    const address: CustomerAddress = {
      label: str(r['label'], 40) || undefined,
      line1: str(r['line1'], 120),
      line2: str(r['line2'], 120) || undefined,
      city: str(r['city'], 60),
      state: str(r['state'], 2).toUpperCase(),
      zip: str(r['zip'], 10),
      deliveryInstructions: str(r['deliveryInstructions'], 500) || undefined,
    };
    if (!address.line1 || !address.city) return { error: `addresses[${i}]: line1 and city are required` };
    if (!US_STATE.test(address.state)) return { error: `addresses[${i}]: state must be a 2-letter code` };
    if (!US_ZIP.test(address.zip)) return { error: `addresses[${i}]: zip must be 12345 or 12345-6789` };
    addresses.push(address);
  }
  return { addresses };
}
