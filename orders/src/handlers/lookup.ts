import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, badRequest, serverError, normalizeEmail } from '@greenlove/shared';
import { emailTrackingLink, issueTrackingLink, orders } from '../lib/orders';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ORDER_NUMBER = /^GLF-\d{4}-\d{6}$/;

const accepted = (): APIGatewayProxyResultV2 => ({
  statusCode: 202,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'If that order exists, we’ve emailed a link to it.' }),
});

/**
 * POST /orders/lookup — body { email, orderNumber }
 * Emails a fresh tracking link to the order's email. Never shows the order itself, and answers the same
 * way whether or not the order exists, so knowing someone's email and order number isn't enough.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: unknown; orderNumber?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim().toUpperCase() : '';
  if (!EMAIL.test(email)) return badRequest('A valid email is required');
  if (!ORDER_NUMBER.test(orderNumber)) return badRequest('Order numbers look like GLF-2026-000123');

  try {
    const db = await getDb();
    const order = await orders(db).findOne({ orderNumber, 'contact.email': email });
    if (order) {
      const link = await issueTrackingLink(db, order);
      await emailTrackingLink(order, link);
      console.log('order link emailed', { orderNumber });
    }
    return accepted();
  } catch (err) {
    console.error('order-lookup error', err);
    return serverError();
  }
};
