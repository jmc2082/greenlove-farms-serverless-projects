import { Customer, CustomerAddress } from '@greenlove/shared';

export function toAddressView({ _id, geo: _geo, ...rest }: CustomerAddress) {
  return { id: _id?.toHexString() ?? null, ...rest, isDefault: rest.isDefault ?? false };
}

export function toCustomerView(c: Customer) {
  return {
    id: c._id.toHexString(),
    email: c.email,
    fullName: c.fullName,
    phone: c.phone,
    addresses: c.addresses.map(toAddressView),
    consent: {
      marketingEmail: c.consent.marketingEmail?.granted ?? false,
      sms: c.consent.sms?.granted ?? false,
    },
    createdAt: c.createdAt,
  };
}
