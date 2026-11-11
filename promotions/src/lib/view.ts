import { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { Db } from 'mongodb';
import { Promotion, PromotionRedemption, getClaims, promotionSummary } from '@greenlove/shared';
import { promotionState } from './validation';

export const promotions = (db: Db) => db.collection<Promotion>('promotions');
export const redemptions = (db: Db) => db.collection<PromotionRedemption>('promotionRedemptions');

export const actor = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  const { sub, email } = getClaims(event);
  return { sub, email };
};

// Staff shape. Send `version` back on update.
export function toAdminPromotion(p: Promotion, now = new Date()) {
  const { _id, ...rest } = p;
  return {
    id: _id.toHexString(),
    ...rest,
    state: promotionState(p, now),
    summary: promotionSummary(p), // the live preview line, e.g. "10% off selected items, orders over $40"
  };
}

export function toAdminRedemption({ _id, promotionId, orderId, customerId, ...rest }: PromotionRedemption) {
  return { id: _id.toHexString(), promotionId: promotionId.toHexString(), orderId: orderId.toHexString(), customerId: customerId.toHexString(), ...rest };
}

export function parseJson(body: string | undefined, isBase64?: boolean): Record<string, unknown> | null {
  try {
    const raw = isBase64 && body ? Buffer.from(body, 'base64').toString('utf8') : body;
    const v = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
