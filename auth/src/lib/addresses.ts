import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, getClaims, notFound, conflict, Customer, CustomerAddress } from '@greenlove/shared';

const MAX_ATTEMPTS = 3;

export class AddressError extends Error {
  constructor(public readonly response: APIGatewayProxyResultV2) {
    super('address error');
  }
}

// Saved before addresses had ids: give them one (and a default) so they can be edited by id.
function normalize(addresses: CustomerAddress[]): CustomerAddress[] {
  const withIds = addresses.map((a) => (a._id ? a : { ...a, _id: new ObjectId() }));
  if (withIds.length > 0 && !withIds.some((a) => a.isDefault)) withIds[0] = { ...withIds[0], isDefault: true };
  return withIds;
}

/**
 * Read the signed-in customer's addresses, apply `change`, and save, but only if nobody else saved the
 * customer in between (checked by updatedAt). Retries a few times on a collision. `change` may throw
 * AddressError to stop with that response. With no change, still saves ids for old addresses.
 */
export async function editAddresses<T>(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  change: (addresses: CustomerAddress[]) => { addresses: CustomerAddress[]; result: T } | null
): Promise<{ customer: Customer; result: T | null } | APIGatewayProxyResultV2> {
  const { sub } = getClaims(event);
  const col = (await getDb()).collection<Customer>('customers');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const customer = await col.findOne({ cognitoSub: sub });
    if (!customer) return notFound('Customer profile not found');

    const current = normalize(customer.addresses ?? []);
    const needsIds = current.some((a, i) => a !== customer.addresses[i]);
    const edit = change(current);
    if (!edit && !needsIds) return { customer, result: null };

    const addresses = edit?.addresses ?? current;
    const now = new Date();
    const saved = await col.findOneAndUpdate(
      { _id: customer._id, updatedAt: customer.updatedAt },
      { $set: { addresses, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (saved) return { customer: saved, result: edit?.result ?? null };
  }
  return conflict('Your account was being updated at the same time. Please try again.');
}

export const findAddress = (addresses: CustomerAddress[], id: string | undefined) =>
  id && ObjectId.isValid(id) ? addresses.findIndex((a) => a._id!.equals(id)) : -1;

// When `index` becomes the default, every other address stops being one.
export const makeDefault = (addresses: CustomerAddress[], index: number) =>
  addresses.map((a, i) => ({ ...a, isDefault: i === index }));

export const isResponse = (v: unknown): v is APIGatewayProxyResultV2 =>
  typeof v === 'object' && v !== null && 'statusCode' in v;
