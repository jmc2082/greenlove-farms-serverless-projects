import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, getClaims, ok, badRequest, notFound, serverError, Customer, ConsentRecord } from '@greenlove/shared';
import { toCustomerView } from '../../lib/customer-view';
import { normalizePhone, parseAddresses } from '../../lib/customer-validation';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const { sub } = getClaims(event);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const now = new Date();
  const updates: Record<string, unknown> = {};

  if (body['fullName'] !== undefined) {
    const fullName = typeof body['fullName'] === 'string' ? body['fullName'].trim() : '';
    if (!fullName || fullName.length > 100) return badRequest('fullName must be 1-100 characters');
    updates['fullName'] = fullName;
  }

  if (body['phone'] !== undefined) {
    const phone = normalizePhone(body['phone']);
    if (!phone) return badRequest('phone must be a 10-digit US number');
    updates['phone'] = phone;
  }

  if (body['addresses'] !== undefined) {
    const { addresses, error } = parseAddresses(body['addresses']);
    if (error) return badRequest(error);
    updates['addresses'] = addresses;
  }

  // Each change is timestamped so we can show when and where consent was given.
  for (const key of ['marketingEmail', 'sms'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return badRequest(`${key} must be a boolean`);
    const record: ConsentRecord = { granted: body[key] as boolean, at: now, source: 'account' };
    updates[`consent.${key}`] = record;
  }

  if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
  updates['updatedAt'] = now;

  try {
    const db = await getDb();
    const result = await db
      .collection<Customer>('customers')
      .findOneAndUpdate({ cognitoSub: sub }, { $set: updates }, { returnDocument: 'after' });

    if (!result) return notFound('Customer profile not found');
    return ok(toCustomerView(result));
  } catch (err) {
    console.error('update-me error', err);
    return serverError();
  }
};
