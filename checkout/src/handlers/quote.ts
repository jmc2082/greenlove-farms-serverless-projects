import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { getDb, ok, badRequest, serverError } from '@greenlove/shared';
import { CheckoutEvent, loadShopper, parseBody } from '../lib/access';
import { FieldErrors } from '../lib/input';
import { buildQuote, parseQuoteInputs, quotes, toQuoteView } from '../lib/quote';
import { getSettings } from '../lib/settings';

/**
 * POST /checkout/quote (guest, body.cartId) | POST /checkout/me/quote (signed in)
 * Body: { cartId?, contact?: { email, fullName, phone }, address? | savedAddressId?,
 *         groups?: [{ fulfillmentClass, method?, pickupLocation?, deliveryDate? }] }
 * Call it on every checkout change; the page shows the latest quote. Problems come back as `issues`
 * (HTTP 200); only malformed input is a 400. Pay with the returned quoteId while `payable` is true.
 */
export const handler = async (event: CheckoutEvent): Promise<APIGatewayProxyResultV2> => {
  const body = parseBody(event);
  if (!body) return badRequest('Invalid JSON body');

  const errors: FieldErrors = {};
  const inputs = parseQuoteInputs(body, errors);
  if (Object.keys(errors).length > 0) return badRequest('Invalid checkout details', errors);

  try {
    const db = await getDb();
    const shopper = await loadShopper(db, event, body['cartId']);
    if (!shopper.ok) return shopper.error;

    const settings = await getSettings(db);
    const quote = await buildQuote({ db, settings, cart: shopper.cart, customer: shopper.customer, inputs, now: new Date() });
    await quotes(db).insertOne(quote);
    return ok(toQuoteView(quote, settings));
  } catch (err) {
    console.error('checkout-quote error', err);
    return serverError();
  }
};
