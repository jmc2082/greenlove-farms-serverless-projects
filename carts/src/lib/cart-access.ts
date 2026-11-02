import { randomUUID } from 'node:crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Db, Filter, ObjectId } from 'mongodb';
import { badRequest, notFound, getClaims, Cart, Customer, cartExpiry } from '@greenlove/shared';

// Handlers serve both /carts/{cartId}/... (anonymous) and /me/cart/... (Cognito JWT) routes.
export type CartEvent = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const carts = (db: Db) => db.collection<Cart>('carts');

export const isSignedIn = (event: CartEvent): event is APIGatewayProxyEventV2WithJWTAuthorizer =>
  Boolean((event.requestContext as { authorizer?: { jwt?: unknown } }).authorizer?.jwt);

export async function getCustomerId(db: Db, event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<ObjectId | null> {
  const customer = await db
    .collection<Customer>('customers')
    .findOne({ cognitoSub: getClaims(event).sub }, { projection: { _id: 1 } });
  return customer?._id ?? null;
}

export type CartScope =
  | { ok: true; filter: Filter<Cart>; customerId: ObjectId | null }
  | { ok: false; error: APIGatewayProxyResultV2 };

/**
 * Signed in: the customer's single ACTIVE cart.
 * Anonymous: the cart named in the path, but only while it is not linked to a customer —
 * so a cartId left in a logged-out browser can't reopen someone's account cart.
 */
export async function cartScope(db: Db, event: CartEvent): Promise<CartScope> {
  if (isSignedIn(event)) {
    const customerId = await getCustomerId(db, event);
    if (!customerId) return { ok: false, error: notFound('Customer profile not found') };
    return { ok: true, filter: { customerId, status: 'ACTIVE' }, customerId };
  }

  const cartId = event.pathParameters?.['cartId'];
  if (!cartId || !UUID_V4.test(cartId)) return { ok: false, error: badRequest('Invalid cart ID') };
  return { ok: true, filter: { _id: cartId, customerId: null }, customerId: null };
}

export function newCart(customerId: ObjectId | null, now = new Date()): Cart {
  return {
    _id: randomUUID(),
    customerId,
    items: [],
    status: 'ACTIVE',
    contact: null,
    abandonedEmailSentAt: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: cartExpiry(0, now),
  };
}

// A unique partial index (customerId, status=ACTIVE) makes this safe under concurrent first writes.
export async function getOrCreateCustomerCart(db: Db, customerId: ObjectId): Promise<Cart> {
  const { _id, ...fresh } = newCart(customerId);
  const result = await carts(db).findOneAndUpdate(
    { customerId, status: 'ACTIVE' },
    { $setOnInsert: { _id, ...fresh } },
    { upsert: true, returnDocument: 'after' }
  );
  return result!;
}
