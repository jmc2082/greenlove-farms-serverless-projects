import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, serverError, PROMO_CODE_PATTERN, normalizePromoCode, promotionSummary, promotionUsable } from '@greenlove/shared';
import { parseJson, promotions } from '../lib/view';

/**
 * POST /promotions/check — body { code }
 * The cart's quick check: is this code usable at all right now? It doesn't look at the cart or the
 * shopper, so per-customer limits, minimums and which items it covers are decided by the checkout quote.
 * Unknown, paused and archived codes all answer the same way, so codes can't be probed.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const body = parseJson(event.body, event.isBase64Encoded);
  if (!body) return badRequest('Invalid JSON body');
  const code = typeof body['code'] === 'string' ? normalizePromoCode(body['code']) : '';
  if (!PROMO_CODE_PATTERN.test(code)) return ok({ code, valid: false, message: 'This code isn’t valid.' });

  try {
    const promo = await promotions(await getDb()).findOne({ code });
    if (!promo) return ok({ code, valid: false, message: 'This code isn’t valid.' });
    const usable = promotionUsable(promo, new Date());
    if (!usable.ok) return ok({ code, valid: false, message: usable.reason });
    return ok({
      code,
      valid: true,
      summary: promotionSummary(promo),
      minSubtotalCents: promo.minSubtotalCents,
      endsAt: promo.endsAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.error('check-promotion error', err);
    return serverError();
  }
};
