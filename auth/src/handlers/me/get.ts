import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, getClaims, ok, notFound, serverError, Customer } from '@greenlove/shared';
import { toCustomerView } from '../../lib/customer-view';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const { sub, groups } = getClaims(event);

  try {
    const db = await getDb();
    const customer = await db.collection<Customer>('customers').findOne({ cognitoSub: sub });
    if (!customer) return notFound('Customer profile not found');

    return ok({ ...toCustomerView(customer), groups });
  } catch (err) {
    console.error('get-me error', err);
    return serverError();
  }
};
