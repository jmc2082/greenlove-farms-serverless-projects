import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, toPublicOrder } from '@greenlove/shared';
import { quotes, sha256 } from '../lib/quote';
import { orders } from '../lib/orders';
import { getStripe } from '../lib/stripe';

/**
 * GET /checkout/status?paymentIntent=pi_...&clientSecret=pi_..._secret_...
 * For the confirmation page, which Stripe redirects to with both values in the URL. Poll until status is
 * PAID (the order is created by the webhook, usually within a few seconds). The client secret proves the
 * caller made this payment, so the order details are safe to return.
 * status: PROCESSING | PAID (with order) | FAILED (with message) | CANCELED
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const qs = event.queryStringParameters ?? {};
  const paymentIntentId = qs['paymentIntent'] ?? '';
  const clientSecret = qs['clientSecret'] ?? '';
  if (!/^pi_[A-Za-z0-9]{8,64}$/.test(paymentIntentId) || !clientSecret.startsWith(`${paymentIntentId}_secret_`)) {
    return badRequest('paymentIntent and clientSecret are required');
  }

  try {
    const db = await getDb();
    const quote = await quotes(db).findOne({ paymentIntentId });
    if (!quote || quote.clientSecretHash !== sha256(clientSecret)) return notFound('Payment not found');

    if (quote.orderId) {
      const order = await orders(db).findOne({ _id: quote.orderId });
      if (order) return ok({ status: 'PAID', order: toPublicOrder(order) });
    }
    // No order yet: ask Stripe, since a retry with another card can succeed after an earlier decline.
    const pi = await (await getStripe()).paymentIntents.retrieve(paymentIntentId);
    if (pi.status === 'canceled') return ok({ status: 'CANCELED' });
    if (pi.status === 'requires_payment_method' && pi.last_payment_error) {
      return ok({ status: 'FAILED', message: pi.last_payment_error.message ?? 'Payment failed' });
    }
    return ok({ status: 'PROCESSING' }); // succeeded (order on its way), processing, or awaiting 3-D Secure
  } catch (err) {
    console.error('checkout-status error', err);
    return serverError();
  }
};
