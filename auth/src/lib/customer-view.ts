import { Customer } from '@greenlove/shared';

export function toCustomerView(c: Customer) {
  return {
    id: c._id.toHexString(),
    email: c.email,
    fullName: c.fullName,
    phone: c.phone,
    addresses: c.addresses,
    consent: {
      marketingEmail: c.consent.marketingEmail?.granted ?? false,
      sms: c.consent.sms?.granted ?? false,
    },
    createdAt: c.createdAt,
  };
}
