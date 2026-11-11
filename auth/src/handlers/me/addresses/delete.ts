import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { noContent, notFound, serverError } from '@greenlove/shared';
import { editAddresses, findAddress, isResponse, makeDefault, AddressError } from '../../../lib/addresses';

// DELETE /me/addresses/{id}. If it was the default, the first remaining address becomes the default.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  const id = event.pathParameters?.['id'];
  try {
    const out = await editAddresses<true>(event, (current) => {
      const index = findAddress(current, id);
      if (index < 0) throw new AddressError(notFound('Address not found'));
      let addresses = current.filter((_, i) => i !== index);
      if (current[index].isDefault && addresses.length > 0) addresses = makeDefault(addresses, 0);
      return { addresses, result: true };
    });
    if (isResponse(out)) return out;
    return noContent();
  } catch (err) {
    if (err instanceof AddressError) return err.response;
    console.error('delete-address error', err);
    return serverError();
  }
};
