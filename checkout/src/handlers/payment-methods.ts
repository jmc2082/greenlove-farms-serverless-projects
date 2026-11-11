import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, noContent, notFound, serverError } from '@greenlove/shared';
import { loadCustomer } from '../lib/access';
import { toSavedCard } from '../lib/stripe-customer';
import { getStripe } from '../lib/stripe';

/**
 * GET /checkout/me/payment-methods — the shopper's saved cards (for the account page).
 * DELETE /checkout/me/payment-methods/{id} — remove one. Only cards on the shopper's own Stripe Customer.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const found = await loadCustomer(db, event);
    if (!found.ok) return found.error;
    const stripeCustomerId = found.customer.stripeCustomerId;
    const stripe = await getStripe();

    if (event.requestContext.http.method === 'DELETE') {
      const id = event.pathParameters?.['id'] ?? '';
      if (!stripeCustomerId || !/^pm_[A-Za-z0-9]{8,64}$/.test(id)) return notFound('Card not found');
      const pm = await stripe.paymentMethods.retrieve(id).catch(() => null);
      const owner = typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id;
      if (!pm || owner !== stripeCustomerId) return notFound('Card not found');
      await stripe.paymentMethods.detach(id);
      return noContent();
    }

    if (!stripeCustomerId) return ok({ items: [] });
    const list = await stripe.customers.listPaymentMethods(stripeCustomerId, { allow_redisplay: 'always', limit: 20 });
    return ok({ items: list.data.map(toSavedCard) });
  } catch (err) {
    console.error('payment-methods error', err);
    return serverError();
  }
};
