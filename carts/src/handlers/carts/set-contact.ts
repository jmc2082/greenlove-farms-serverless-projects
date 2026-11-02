import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, notFound, serverError, normalizeEmail } from '@greenlove/shared';
import { carts, cartScope } from '../../lib/cart-access';
import { toCartView } from '../../lib/cart-view';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// PUT /carts/{cartId}/contact — body { email, marketingEmail }
// Guest checkout step 1. Stored on the cart only — never on a customer record, since this endpoint is
// unauthenticated and must not let anyone change another person's consent. Signed-in carts use the account.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  let body: { email?: string; marketingEmail?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!EMAIL.test(email) || email.length > 254) return badRequest('A valid email is required');
  if (typeof body.marketingEmail !== 'boolean') return badRequest('marketingEmail must be a boolean');

  try {
    const db = await getDb();
    const scope = await cartScope(db, event);
    if (!scope.ok) return scope.error;

    const now = new Date();
    const cart = await carts(db).findOneAndUpdate(
      { ...scope.filter, status: 'ACTIVE' },
      {
        $set: {
          contact: { email, marketingEmail: { granted: body.marketingEmail, at: now, source: 'checkout' } },
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );
    if (!cart) return notFound('Cart not found or no longer active');

    return ok(await toCartView(db, cart));
  } catch (err) {
    console.error('set-cart-contact error', err);
    return serverError();
  }
};
