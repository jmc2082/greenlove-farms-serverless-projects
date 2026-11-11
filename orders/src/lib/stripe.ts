import Stripe from 'stripe';
import { getParam } from '@greenlove/shared';

let client: Stripe | null = null;

// Keys live in SSM: /greenlove/{env}/stripe-secret-key and /greenlove/{env}/stripe-webhook-secret.
// `sam local` can set STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET directly.
export async function getStripe(): Promise<Stripe> {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY ?? (await getParam(`/greenlove/${process.env.ENVIRONMENT}/stripe-secret-key`, true));
  client = new Stripe(key, { maxNetworkRetries: 2, timeout: 8000, appInfo: { name: 'greenlove-checkout' } });
  return client;
}

export const getWebhookSecret = async () =>
  process.env.STRIPE_WEBHOOK_SECRET ?? getParam(`/greenlove/${process.env.ENVIRONMENT}/stripe-webhook-secret`, true);
