import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { Db } from 'mongodb';
import { Cart, Customer, badRequest, getClaims, notFound } from '@greenlove/shared';
import { CheckoutQuote } from './quote';

// Each checkout route exists twice: /checkout/... for guests (cartId in the body) and /checkout/me/... with a
// Cognito JWT (the customer's own cart). Same rules as the carts stack: a cart linked to a customer is never
// reachable by its cartId.
export type CheckoutEvent = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isSignedIn = (event: CheckoutEvent): event is APIGatewayProxyEventV2WithJWTAuthorizer =>
  Boolean((event.requestContext as { authorizer?: { jwt?: unknown } }).authorizer?.jwt);

export type Shopper =
  | { ok: true; cart: Cart; customer: Customer | null }
  | { ok: false; error: APIGatewayProxyResultV2 };

export async function loadShopper(db: Db, event: CheckoutEvent, cartId: unknown): Promise<Shopper> {
  const cartsCol = db.collection<Cart>('carts');
  if (isSignedIn(event)) {
    const customer = await db.collection<Customer>('customers').findOne({ cognitoSub: getClaims(event).sub });
    if (!customer) return { ok: false, error: notFound('Customer profile not found') };
    const cart = await cartsCol.findOne({ customerId: customer._id, status: 'ACTIVE' });
    if (!cart) return { ok: false, error: notFound('Your cart is empty') };
    return { ok: true, cart, customer };
  }

  if (typeof cartId !== 'string' || !UUID_V4.test(cartId)) return { ok: false, error: badRequest('cartId is required') };
  const cart = await cartsCol.findOne({ _id: cartId, customerId: null, status: 'ACTIVE' });
  if (!cart) return { ok: false, error: notFound('Cart not found or no longer active') };
  return { ok: true, cart, customer: null };
}

// A quote can only be paid by whoever created it.
export const ownsQuote = (q: CheckoutQuote, shopper: { cart: Cart; customer: Customer | null }) =>
  q.cartId === shopper.cart._id && (shopper.customer ? q.customerId?.equals(shopper.customer._id) === true : q.customerId === null);

export function parseBody(event: CheckoutEvent): Record<string, unknown> | null {
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw ?? '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// Signed-in routes that don't need a cart (saved cards).
export async function loadCustomer(db: Db, event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<{ ok: true; customer: Customer } | { ok: false; error: APIGatewayProxyResultV2 }> {
  const customer = await db.collection<Customer>('customers').findOne({ cognitoSub: getClaims(event).sub });
  return customer ? { ok: true, customer } : { ok: false, error: notFound('Customer profile not found') };
}
