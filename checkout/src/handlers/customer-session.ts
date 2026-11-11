import { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, serverError } from '@greenlove/shared';
import { loadCustomer } from '../lib/access';
import { ensureStripeCustomer } from '../lib/stripe-customer';
import { getStripe } from '../lib/stripe';

/**
 * POST /checkout/me/customer-session
 * For the signed-in checkout: pass `customerSessionClientSecret` to stripe.elements({ ..., customerSessionClientSecret })
 * and the Payment Element shows the shopper's saved cards, a "Save this card" box and a remove option.
 * Saved cards are for paying while the shopper is present only (we never charge them later on our own).
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  try {
    const db = await getDb();
    const found = await loadCustomer(db, event);
    if (!found.ok) return found.error;

    const stripe = await getStripe();
    const stripeCustomerId = await ensureStripeCustomer(db, stripe, found.customer);
    const session = await stripe.customerSessions.create({
      customer: stripeCustomerId,
      components: {
        payment_element: {
          enabled: true,
          features: {
            payment_method_redisplay: 'enabled',
            payment_method_save: 'enabled',
            payment_method_save_usage: 'on_session',
            payment_method_remove: 'enabled',
          },
        },
      },
    });
    return ok({ customerSessionClientSecret: session.client_secret, expiresAt: new Date(session.expires_at * 1000).toISOString() });
  } catch (err) {
    console.error('customer-session error', err);
    return serverError();
  }
};
