import { PostalAddress, normalizeEmail } from '@greenlove/shared';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP = /^\d{5}(-\d{4})?$/;
// The 50 states, DC, and military mail. Territories ship separately and aren't offered yet.
export const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AA AE AP'.split(' ')
);

export type FieldErrors = Record<string, string>;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function parseContact(raw: unknown, errors: FieldErrors) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(text(r['email'], 254));
  const fullName = text(r['fullName'], 120);
  const phone = text(r['phone'], 30);
  if (!EMAIL.test(email)) errors['contact.email'] = 'A valid email is required';
  if (!fullName) errors['contact.fullName'] = 'required';
  if (phone && !/^[+\d][\d\s().-]{6,}$/.test(phone)) errors['contact.phone'] = 'invalid';
  return { email, fullName, phone };
}

export function parseAddress(raw: unknown, errors: FieldErrors, prefix = 'address'): PostalAddress | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const a: PostalAddress = {
    name: text(r['name'], 120) || undefined,
    line1: text(r['line1'], 120),
    line2: text(r['line2'], 120) || undefined,
    city: text(r['city'], 80),
    state: text(r['state'], 2).toUpperCase(),
    zip: text(r['zip'], 10),
    deliveryInstructions: text(r['deliveryInstructions'], 500) || undefined,
  };
  if (!a.line1) errors[`${prefix}.line1`] = 'required';
  if (!a.city) errors[`${prefix}.city`] = 'required';
  if (!US_STATES.has(a.state)) errors[`${prefix}.state`] = 'must be a U.S. state code';
  if (!ZIP.test(a.zip)) errors[`${prefix}.zip`] = 'must be 12345 or 12345-6789';
  return a;
}
