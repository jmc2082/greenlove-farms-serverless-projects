import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { created, badRequest, conflict, serverError, CustomerAddress } from '@greenlove/shared';
import { editAddresses, isResponse, makeDefault, AddressError } from '../../../lib/addresses';
import { parseAddress, MAX_ADDRESSES } from '../../../lib/customer-validation';
import { toAddressView } from '../../../lib/customer-view';

// POST /me/addresses — body: address fields, optional isDefault. The first saved address is always the default.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const { address, error } = parseAddress(body);
  if (error) return badRequest(error);

  try {
    const out = await editAddresses<CustomerAddress>(event, (current) => {
      if (current.length >= MAX_ADDRESSES) throw new AddressError(conflict(`At most ${MAX_ADDRESSES} addresses — delete one first`));
      const added: CustomerAddress = { ...address!, _id: new ObjectId(), isDefault: false };
      let addresses = [...current, added];
      if (body['isDefault'] === true || current.length === 0) addresses = makeDefault(addresses, addresses.length - 1);
      return { addresses, result: addresses[addresses.length - 1] };
    });
    if (isResponse(out)) return out;
    return created(toAddressView(out.result!));
  } catch (err) {
    if (err instanceof AddressError) return err.response;
    console.error('create-address error', err);
    return serverError();
  }
};
