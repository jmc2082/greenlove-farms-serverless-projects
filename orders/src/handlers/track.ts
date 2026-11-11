import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, toPublicOrder } from '@greenlove/shared';
import { hashToken, orders } from '../lib/orders';

// GET /orders/track?token= — a guest's order, from the link in their email.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const token = event.queryStringParameters?.['token'] ?? '';
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return badRequest('A tracking token is required');

  try {
    const order = await orders(await getDb()).findOne({ guestAccessTokenHash: hashToken(token) });
    return order ? ok(toPublicOrder(order)) : notFound('This link is no longer valid. Request a new one from the order lookup page.');
  } catch (err) {
    console.error('track-order error', err);
    return serverError();
  }
};
