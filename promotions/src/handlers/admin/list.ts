import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Filter } from 'mongodb';
import { getDb, isStaff, ok, badRequest, forbidden, serverError, Promotion } from '@greenlove/shared';
import { promotions, toAdminPromotion } from '../../lib/view';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATES = ['active', 'scheduled', 'expired', 'paused', 'archived'] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /promotions/admin?state=active|scheduled|expired|paused|archived&q=&page=&limit=
// Without `state`, everything except archived codes. Newest first.
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!isStaff(event)) return forbidden('Staff role required');

  const q = event.queryStringParameters ?? {};
  const page = Math.max(1, parseInt(q['page'] ?? '1', 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q['limit'] ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));
  const state = q['state'];
  if (state && !STATES.includes(state as (typeof STATES)[number])) return badRequest(`state must be one of: ${STATES.join(', ')}`);

  const now = new Date();
  const notEnded = { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] };
  const filter: Filter<Promotion> =
    state === 'active' ? { status: 'ACTIVE', $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, notEnded] } :
    state === 'scheduled' ? { status: 'ACTIVE', startsAt: { $gt: now } } :
    state === 'expired' ? { status: 'ACTIVE', endsAt: { $lte: now } } :
    state === 'paused' ? { status: 'PAUSED' } :
    state === 'archived' ? { status: 'ARCHIVED' } :
    { status: { $ne: 'ARCHIVED' } };
  if (q['q']) {
    const re = new RegExp(escapeRegex(q['q'].slice(0, 60)), 'i');
    filter.$or = [{ code: re }, { description: re }];
  }

  try {
    const col = promotions(await getDb());
    const [items, total] = await Promise.all([
      col.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      col.countDocuments(filter),
    ]);
    return ok({ items: items.map((p) => toAdminPromotion(p, now)), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('admin-list-promotions error', err);
    return serverError();
  }
};
