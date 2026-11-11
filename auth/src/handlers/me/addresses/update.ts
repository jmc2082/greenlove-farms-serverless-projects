import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok, badRequest, notFound, serverError, CustomerAddress } from '@greenlove/shared';
import { editAddresses, findAddress, isResponse, makeDefault, AddressError } from '../../../lib/addresses';
import { parseAddress } from '../../../lib/customer-validation';
import { toAddressView } from '../../../lib/customer-view';

// PUT /me/addresses/{id} — partial: sent fields replace the saved ones. isDefault: true makes it the default
// (a default can't be switched off directly; make another address the default instead).
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badRequest('Body must be an object');
  const id = event.pathParameters?.['id'];

  try {
    const out = await editAddresses<CustomerAddress>(event, (current) => {
      const index = findAddress(current, id);
      if (index < 0) throw new AddressError(notFound('Address not found'));

      const { _id, isDefault, geo: _geo, ...saved } = current[index];
      const { address, error } = parseAddress({ ...saved, ...body });
      if (error) throw new AddressError(badRequest(error));

      // geo was worked out for the old street address, so it's dropped when the address changes.
      let addresses = current.map((a, i) => (i === index ? { ...address!, _id, isDefault } : a));
      if (body['isDefault'] === true) addresses = makeDefault(addresses, index);
      return { addresses, result: addresses[index] };
    });
    if (isResponse(out)) return out;
    return ok(toAddressView(out.result!));
  } catch (err) {
    if (err instanceof AddressError) return err.response;
    console.error('update-address error', err);
    return serverError();
  }
};
