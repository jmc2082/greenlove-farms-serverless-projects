import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, created, badRequest, forbidden, conflict, serverError, Promotion } from '@greenlove/shared';
import { validatePromotion } from '../../lib/validation';
import { actor, parseJson, promotions, toAdminPromotion } from '../../lib/view';

// POST /promotions/admin — create a code. Codes are stored uppercase and must be unique.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const body = parseJson(event.body, event.isBase64Encoded);
  if (!body) return badRequest('Invalid JSON body');

  const { fields, errors } = validatePromotion(body);
  if (errors) return badRequest('Validation failed', errors);

  const now = new Date();
  const by = actor(event);
  const promo: Promotion = { _id: new ObjectId(), ...fields!, redemptionCount: 0, version: 1, createdBy: by, updatedBy: by, createdAt: now, updatedAt: now };
  try {
    await promotions(await getDb()).insertOne(promo);
    return created(toAdminPromotion(promo, now));
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return conflict(`The code ${promo.code} already exists`);
    console.error('admin-create-promotion error', err);
    return serverError();
  }
};
