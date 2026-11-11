import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, notFound, serverError } from '@greenlove/shared';
import { promotions, toAdminPromotion } from '../../lib/view';

// GET /promotions/admin/{id}
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid promotion ID');
  try {
    const promo = await promotions(await getDb()).findOne({ _id: new ObjectId(id) });
    return promo ? ok(toAdminPromotion(promo)) : notFound('Promotion not found');
  } catch (err) {
    console.error('admin-get-promotion error', err);
    return serverError();
  }
};
