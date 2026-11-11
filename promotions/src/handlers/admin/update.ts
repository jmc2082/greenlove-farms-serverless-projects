import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ObjectId } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, notFound, conflict, serverError } from '@greenlove/shared';
import { toEditableInput, validatePromotion } from '../../lib/validation';
import { actor, parseJson, promotions, toAdminPromotion } from '../../lib/view';

/**
 * PUT /promotions/admin/{id} — partial update; `version` (from the last read) is required.
 * Pause / resume / archive by sending `status`. The code can't be renamed once it has been used,
 * so redemption history and shared links stay meaningful.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');
  const id = event.pathParameters?.['id'];
  if (!id || !ObjectId.isValid(id)) return badRequest('Invalid promotion ID');
  const body = parseJson(event.body, event.isBase64Encoded);
  if (!body) return badRequest('Invalid JSON body');

  const { version, ...changes } = body;
  if (typeof version !== 'number') return badRequest('version is required (from the last read of this promotion)');

  try {
    const col = promotions(await getDb());
    const current = await col.findOne({ _id: new ObjectId(id) });
    if (!current) return notFound('Promotion not found');
    if (current.version !== version) return conflict('Promotion was changed by someone else — reload and try again');

    const { fields, errors } = validatePromotion({ ...toEditableInput(current), ...changes });
    if (errors) return badRequest('Validation failed', errors);
    if (fields!.code !== current.code && current.redemptionCount > 0) {
      return badRequest('Validation failed', { code: 'can’t be changed after the code has been used; create a new one instead' });
    }

    const result = await col.findOneAndUpdate(
      { _id: current._id, version },
      { $set: { ...fields!, updatedBy: actor(event), updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after' }
    );
    if (!result) return conflict('Promotion was changed by someone else — reload and try again');
    return ok(toAdminPromotion(result));
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return conflict('That code already exists');
    console.error('admin-update-promotion error', err);
    return serverError();
  }
};
