import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ok, serverError } from '@greenlove/shared';
import { editAddresses, isResponse } from '../../../lib/addresses';
import { toAddressView } from '../../../lib/customer-view';

// GET /me/addresses — saved addresses, default first.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const out = await editAddresses(event, () => null);
    if (isResponse(out)) return out;
    const items = (out.customer.addresses ?? []).map(toAddressView).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return ok({ items });
  } catch (err) {
    console.error('list-addresses error', err);
    return serverError();
  }
};
