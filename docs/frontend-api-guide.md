# Frontend API guide

How the Nuxt site (`full-stacks/greenlove-farms-nuxtjs`) talks to this backend: which endpoint each page calls, what it sends, and what comes back. Sign-in is already wired; see the frontend's `docs/auth-and-users/cognito-auth.md`. This guide covers everything else.

For exact, runnable request bodies, see the Postman collection (`postman/greenlove-farms.postman_collection.json`). It exercises every endpoint here.

## Basics

| | Dev | Prod |
|---|---|---|
| API base | `https://api-dev.greenlove-farms.com` | `https://api.greenlove-farms.com` |
| Browser origins allowed | `http://localhost:3000` | `https://greenlove-farms.com`, `https://www.greenlove-farms.com` |
| Stripe publishable key | `pk_test_…` (sandbox) | `pk_live_…` |

- **Paths** start with the stack name: `/catalog/...`, `/carts/...`, `/checkout/...`, `/promotions/...`, `/orders/...`, `/auth/...`.
- **Signed-in routes** need `Authorization: Bearer <idToken>`. `useApi()` adds it with `{ auth: 'required' }`. Missing or expired token → 401.
- **Staff routes** (`/admin`) also need the user in the Cognito `Staff` or `Admins` group → otherwise 403.
- **Money** is always whole cents (`priceCents: 800` = $8.00). Dates are ISO strings. Delivery days are `YYYY-MM-DD` in farm time (Central).
- **IDs** are strings. Cart ids are UUIDs; everything else is a 24-character hex id.

**Errors** have one shape:

```json
{ "error": "Invalid checkout details", "details": { "contact.email": "A valid email is required" } }
```

`details` appears on validation errors (400), keyed by field path, so forms can show each message under its field. Checkout's 409s are different: see [Pay](#3-pay).

| Status | Meaning |
|---|---|
| 400 | Bad input; show `details` |
| 401 | Not signed in, or token expired (`useApi` refreshes and retries once) |
| 403 | Signed in but not Staff/Admin |
| 404 | Not found (or not yours) |
| 409 | Conflict: out of stock, edited by someone else, order changed |
| 429 | Throttled (order lookup, tracking, promo check) |

---

## Shop: catalog (public)

### `GET /catalog/products`

The shop grid and search results.

| Query | Notes |
|---|---|
| `q` | Search text, 2+ characters. Results ranked by relevance unless `sort` is given |
| `category` | A category `slug` |
| `sort` | `featured` (default), `newest`, `price_asc`, `price_desc`, `relevance` (needs `q`) |
| `methods` | Comma-separated: `SHIP`, `LOCAL_DELIVERY`, `PICKUP` |
| `minPrice`, `maxPrice` | Cents |
| `inStock` | `true` hides sold-out products |
| `fulfillmentClass` | `STOCKED`, `MADE_TO_ORDER`, `GROW_TO_ORDER`, `CROP_RESERVATION` |
| `page`, `limit` | Default 1 and 24; `limit` up to 100 |

Returns `{ items: Product[], page, limit, total, totalPages, sort }`.

### `GET /catalog/products/{slug}`

One product page. Returns a `Product`; 404 if it doesn't exist or isn't active.

```jsonc
{
  "id": "…", "slug": "lavender-bar-soap", "name": "Lavender Bar Soap",
  "description": "…", "shortDescription": "…", "storage": "Keep dry.",
  "label": { "ingredients": "…", "allergens": [] },   // or null
  "badges": ["NEW"],                                   // NEW, BESTSELLER, LIMITED, SEASONAL, STAFF_PICK
  "category": "body-care",
  "fulfillmentClass": "STOCKED",
  "fulfillmentProfile": { "methods": ["SHIP", "LOCAL_DELIVERY"], "perishable": false, "handlingDays": 2 },
  "images": [{ "publicId": "greenlove/prod/products/…", "alt": "…" }],  // Cloudinary public ids
  "priceFromCents": 800,                               // lowest variant price
  "availability": {
    "status": "IN_STOCK",          // IN_STOCK | LOW_STOCK (≤5 left) | OUT_OF_STOCK | NOT_YET_AVAILABLE
    "remaining": 25,
    "nextDeliveryDate": "2026-11-17",  // next Tue/Thu it can be delivered (null if not local)
    "orderBy": "2026-11-16T00:00:00.000Z", // order by this time for that date
    "shipsWithinDays": 2               // null if it doesn't ship
  },
  "variants": [{ "id": "…", "sku": "LAV-4OZ", "name": "4 oz bar", "priceCents": 800, "netWeight": "4 oz (113 g)", "available": 25 }]
}
```

- `variants[].available` is units left (`null` = not stock-tracked). Use it to cap the quantity picker.
- Only `STOCKED` products can be bought right now; the others show `NOT_YET_AVAILABLE`.
- Build image URLs from `publicId` with Cloudinary's URL format (cloud name in the frontend config).

### `GET /catalog/products/suggest?q=`

Search-as-you-type (2+ characters). Returns `{ products: [{ id, slug, name, image, priceFromCents }], categories: [{ slug, name }] }`.

### `GET /catalog/categories`

Returns `{ items: [{ slug, name, blurb, image, sortOrder, productCount }] }`. `productCount` 0 → show "Coming soon".

---

## Cart

Two ways to reach a cart:

- **Guest:** `POST /carts/new` creates one. Keep its `cartId` (e.g. in `localStorage`) and use the `/carts/{cartId}/...` routes.
- **Signed in:** the `/carts/me/...` routes, with the token. The customer has one cart, created on first use.

When a guest signs in, call **`POST /carts/me/cart/merge { cartId }`** once, then drop the stored `cartId`. It moves the guest cart (and recently viewed products) into the account. A cart linked to an account can never be reached by its `cartId` again.

| Action | Guest | Signed in |
|---|---|---|
| Create | `POST /carts/new` → 201 | (automatic) |
| Read | `GET /carts/{cartId}` | `GET /carts/me/cart` |
| Set quantity | `PUT /carts/{cartId}/items` | `PUT /carts/me/cart/items` |
| Remove line | `DELETE /carts/{cartId}/items/{variantId}` | `DELETE /carts/me/cart/items/{variantId}` |
| Save checkout email | `PUT /carts/{cartId}/contact` | (uses the account) |

- **Set quantity** body: `{ productId, variantId, qty }`. `qty` is 0–99 and replaces the current amount; 0 removes the line. Up to 50 lines. 409 `"Only 3 available"` / `"Out of stock"`; 404 if the product is no longer sold.
- **Save checkout email** body: `{ email, marketingEmail: boolean }`. Call it as soon as a guest types their email at checkout (used for abandoned-cart reminders and the marketing opt-in).

Every cart call returns the cart:

```jsonc
{
  "cartId": "…uuid…",          // null for a signed-in shopper with no cart yet
  "status": "ACTIVE",
  "itemCount": 3, "subtotalCents": 2400,   // indicative; checkout re-prices
  "contact": { "email": "…", "marketingEmail": true },  // or null
  "lines": [{
    "productId": "…", "variantId": "…", "qty": 3,
    "availability": "OK",       // OK | LIMITED (fewer in stock than qty) | UNAVAILABLE (no longer sold)
    "available": 25,
    "product": { "slug": "…", "name": "…", "fulfillmentClass": "STOCKED", "methods": ["SHIP"], "image": {…} },
    "variant": { "sku": "…", "name": "4 oz bar", "priceCents": 800 },
    "lineTotalCents": 2400
  }]
}
```

Show `LIMITED` and `UNAVAILABLE` lines clearly. Checkout won't go through until they're fixed. A guest cart that's gone (expired after 7 days empty or 30 days with items) returns 404: start a new one.

### Recently viewed and watchlist

| | Guest | Signed in |
|---|---|---|
| Record a product view | `POST /carts/{cartId}/views { productId }` → 204 | `POST /carts/me/views` |
| Recently viewed | `GET /carts/{cartId}/views?limit=&exclude=` (default 12, max 24) | `GET /carts/me/views` |
| Watchlist | — | `GET /carts/me/watchlist`, `PUT` / `DELETE /carts/me/watchlist/{productId}` (204) |

Lists return `{ items: [{ viewedAt | addedAt, product: Product }] }`. Use `exclude=<productId>` on a product page to leave out the current product.

---

## Checkout

Guests use `/checkout/...` and send `cartId` in the body. Signed-in shoppers use `/checkout/me/...` with the token and no `cartId`.

```
 quote  ──(every change)──►  quote  ──►  mount Payment Element  ──►  pay  ──►  stripe.confirmPayment
                                                                                       │
                                               confirmation page  ◄── status (poll) ◄──┘ (redirect)
```

### 1. Quote

`POST /checkout/quote` (guest) · `POST /checkout/me/quote`

Call it whenever anything on the checkout page changes: method, address, date, promo code. It's cheap and never changes stock.

```jsonc
{
  "cartId": "…",                                    // guests only
  "contact": { "email": "…", "fullName": "Ada Lovelace", "phone": "713-555-0100" },  // phone optional
  "address": { "name": "…", "line1": "…", "line2": "…", "city": "Houston", "state": "TX", "zip": "77070",
               "deliveryInstructions": "Leave by the gate" },
  // or, signed in: "savedAddressId": "…" (one of /auth/me/addresses) instead of "address"
  "groups": [{ "fulfillmentClass": "STOCKED", "method": "LOCAL_DELIVERY", "deliveryDate": "2026-11-17" }],
  "promoCode": "SPRING10"                           // optional
}
```

Send what you have so far. The first call can be just `{ cartId }` to learn the groups and their options. Field errors return 400 with `details`. Everything else comes back as a 200 quote:

```jsonc
{
  "quoteId": "…",
  "payable": false,               // true when issues is empty → enable "Place order"
  "issues": [{ "code": "ADDRESS_REQUIRED", "message": "Enter a delivery address.", "groupKey": "STOCKED" }],
  "requiresLabelAck": false,      // true → show a "I've read the product labels" checkbox
  "groups": [{
    "key": "STOCKED", "fulfillmentClass": "STOCKED",
    "methodOptions": ["LOCAL_DELIVERY", "SHIP"],   // what this group can use; show these as choices
    "method": "LOCAL_DELIVERY",
    "dateOptions": [{ "date": "2026-11-17", "orderBy": "…" }, …],  // local delivery: the next 4 Tue/Thu
    "deliveryDate": "2026-11-17",                    // defaults to the first option
    "shipsWithinDays": null,                         // set for SHIP
    "pickupLocation": null, "pickupLocationOptions": [],
    "address": {…},
    "items": [{ "name": "…", "variantName": "…", "qty": 3, "unitPriceCents": 800, "discountCents": 0, "lineTotalCents": 2400, "taxCents": 0, … }],
    "subtotalCents": 2400, "feeCents": 895, "taxCents": 0
  }],
  "totals": { "subtotalCents": 2400, "discountCents": 0, "deliveryCents": 895, "shippingCents": 0,
              "taxCents": 0, "totalCents": 3295 },   // tax and total are null until there's an address
  "promotion": { "code": "SPRING10", "applied": true, "message": null, "summary": "10% off",
                 "discountCents": 240, "feeDiscountCents": 0, "savingsCents": 240 },  // or null
  "freeDelivery": { "thresholdCents": 4000, "remainingCents": 1600 }  // "$16 away from free delivery"
}
```

**Issue codes.** Show `message` next to the group or line it names (`groupKey`, `variantId`):

| Code | What to do |
|---|---|
| `CART_EMPTY` | Back to the shop |
| `ITEM_UNAVAILABLE`, `NOT_ENOUGH_STOCK` (`available`), `NOT_SOLD_ONLINE_YET` | Fix the cart line |
| `METHOD_REQUIRED`, `NO_COMMON_METHOD` | Pick a method, or split the order |
| `ADDRESS_REQUIRED`, `OUTSIDE_DELIVERY_AREA`, `SHIPPING_NOT_AVAILABLE` | Address or method |
| `DELIVERY_DATE_UNAVAILABLE` | Pick another date (its cutoff passed) |
| `PICKUP_LOCATION_REQUIRED` | Pick a location (pickup is off for now, so this won't appear) |
| `CONTACT_REQUIRED` | Email and name |
| `TAX_UNAVAILABLE` | Try again shortly |
| `TOTAL_TOO_LOW` | Order total is below Stripe's minimum |

A promo code that doesn't apply doesn't block payment: `promotion.applied` is false and `promotion.message` says why. Show it under the code field.

**Delivery rules today:** local delivery $8.95, free when local items total $40+ after discounts, Tuesdays and Thursdays to 27 ZIPs around the Houston farm (order by Sunday 6 PM for Tuesday, Tuesday 6 PM for Thursday). Shipping $7.95 flat. No pickup yet.

Optional, before quoting: `POST /promotions/check { code }` → `{ code, valid, message? , summary?, minSubtotalCents?, endsAt? }` for instant feedback on the code field. The quote is still what counts.

### 2. Mount the Payment Element

Use Stripe.js with a **deferred PaymentIntent**: mount the element with the quote's amount before calling pay.

```ts
const stripe = await loadStripe(publishableKey);
const elements = stripe.elements({
  mode: 'payment',
  amount: quote.totals.totalCents,
  currency: 'usd',
  // signed in only: saved cards, "Save this card", remove
  customerSessionClientSecret,      // from POST /checkout/me/customer-session
});
const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element');
// When a new quote changes the total: elements.update({ amount: quote.totals.totalCents })
```

Signed in: `POST /checkout/me/customer-session` → `{ customerSessionClientSecret, expiresAt }`. Fetch a new one for each checkout visit.

### 3. Pay

`POST /checkout/pay` (guest) · `POST /checkout/me/pay`

```json
{ "quoteId": "…", "cartId": "…(guests)", "labelsReviewed": true }
```

`labelsReviewed` is needed only when `requiresLabelAck` was true.

```ts
const { error: submitError } = await elements.submit();       // validates the card fields first
if (submitError) return show(submitError.message);
const pay = await api.post('/checkout/pay', { quoteId, cartId });  // → { quoteId, paymentIntentId, clientSecret, amountCents, currency }
const { error } = await stripe.confirmPayment({
  elements,
  clientSecret: pay.clientSecret,
  confirmParams: { return_url: `${location.origin}/checkout/complete` },
});
if (error) show(error.message);   // card declined etc.: the shopper can fix it and press Pay again
```

Pay re-checks the order and holds the stock for 30 minutes. It returns **409** with a code:

| `error` | Body also has | Do this |
|---|---|---|
| `QUOTE_CHANGED` | `message`, `quote` (new) | Show the new total; the shopper confirms and pays with the new `quoteId` |
| `QUOTE_NOT_PAYABLE` | `message`, `quote` | Show `quote.issues` |
| `NOT_ENOUGH_STOCK` | `message`, `shortages` | Send them back to the cart |
| `ALREADY_PAID` | `paymentIntentId` | Go to the confirmation page |

A plain 409 without a code ("already being set up") means a double click; wait a moment and retry. Calling pay again for the same quote returns the same payment, so retries after a declined card are safe.

### 4. Confirmation page

Stripe redirects to `return_url` with `?payment_intent=…&payment_intent_client_secret=…`. Poll:

`GET /checkout/status?paymentIntent=<payment_intent>&clientSecret=<payment_intent_client_secret>`

| `status` | Show |
|---|---|
| `PROCESSING` | "Finishing up…" and poll again in 1–2 seconds (usually under 5 seconds total) |
| `PAID` | `order` (same shape as [an order](#order-shape)): order number, items, totals |
| `FAILED` | `message`; link back to checkout to try another card |
| `CANCELED` | "This payment was cancelled"; back to checkout |

After `PAID`: the cart is finished. Guests should drop their stored `cartId`; signed-in shoppers get a fresh cart automatically. The confirmation email goes out on its own.

### Saved cards (account page)

- `GET /checkout/me/payment-methods` → `{ items: [{ id, brand, last4, expMonth, expYear, wallet }] }`
- `DELETE /checkout/me/payment-methods/{id}` → 204

---

## Orders

### Signed in

- `GET /orders/me?page=&limit=` (default 20, max 50) → `{ items: OrderSummary[], page, limit, total, totalPages }`, newest first.
- `GET /orders/me/{orderNumber}` → [an order](#order-shape). Accepts the order number (`GLF-2026-000182`) or id.

```jsonc
// OrderSummary
{ "id": "…", "orderNumber": "GLF-2026-000182", "createdAt": "…", "status": "PAID", "totalCents": 3295,
  "itemCount": 3, "statusSummary": "1 out for delivery",
  "groups": [{ "method": "LOCAL_DELIVERY", "status": "OUT_FOR_DELIVERY", "deliveryDate": "2026-11-17" }] }
```

### Guests

- **Tracking page** `/orders/track?token=…` (the link in the confirmation email) calls `GET /orders/track?token=…` → an order, or 404 "This link is no longer valid…".
- **Order lookup form:** `POST /orders/lookup { email, orderNumber }` → always 202 `{ message }`, whether or not the order exists. If it does, a fresh tracking link is emailed (and the old one stops working).

**Pages the emails link to (must exist):** `/account/orders/{orderNumber}` (signed-in shoppers) and `/orders/track?token=` (guests).

### Order shape

```jsonc
{
  "id": "…", "orderNumber": "GLF-2026-000182", "createdAt": "…",
  "status": "PAID",            // PAID | PARTIALLY_FULFILLED | FULFILLED | CANCELLED | PARTIALLY_REFUNDED | REFUNDED
  "placedBy": "GUEST",         // or CUSTOMER
  "contact": { "email": "…", "fullName": "…", "phone": "…" },
  "totals": { "subtotalCents": …, "discountCents": …, "deliveryCents": …, "shippingCents": …, "taxCents": …, "totalCents": … },
  "promotion": { "code": "SPRING10", "savingsCents": 240 },    // or null
  "payment": { "status": "SUCCEEDED", "method": { "type": "card", "brand": "visa", "last4": "4242" }, "refundedCents": 0 },  // status: SUCCEEDED | PARTIALLY_REFUNDED | REFUNDED
  "fulfillmentGroups": [{
    "id": "…", "method": "LOCAL_DELIVERY", "status": "SCHEDULED",
    "deliveryDate": "2026-11-17", "shipsWithinDays": null, "address": {…}, "pickupLocation": null,
    "trackingNumber": null, "trackingUrl": null,               // set when shipped
    "feeCents": 895, "taxCents": 0,
    "items": [{ "name": "…", "variantName": "…", "qty": 3, "unitPriceCents": 800, "discountCents": 0, "lineTotalCents": 2400, … }],
    "statusHistory": [{ "status": "SCHEDULED", "at": "…" }]
  }]
}
```

Each group moves through its own steps. Show them as a progress bar:

| Method | Steps |
|---|---|
| `SHIP` | PREPARING → SHIPPED → DELIVERED |
| `LOCAL_DELIVERY` | SCHEDULED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED |
| `PICKUP` | SCHEDULED → PREPARING → READY → PICKED_UP |

Any unfinished group can become `CANCELLED`.

---

## Account

| | |
|---|---|
| `GET /auth/me` | `{ id, email, fullName, phone, addresses: Address[], consent: { marketingEmail, sms }, createdAt }` |
| `PUT /auth/me` | Any of `{ fullName, phone, marketingEmail, sms }` (consents are booleans) |
| `GET /auth/me/addresses` | `{ items: Address[] }` |
| `POST /auth/me/addresses` | `{ label?, line1, line2?, city, state, zip, deliveryInstructions?, isDefault? }` → 201 Address |
| `PUT /auth/me/addresses/{id}` | Same fields → Address |
| `DELETE /auth/me/addresses/{id}` | 204 |

`Address` = `{ id, label, line1, line2, city, state, zip, deliveryInstructions, isDefault }`. Pass an address's `id` to checkout as `savedAddressId`.

---

## Staff and admin

All need a Staff or Admins token. Exact bodies are in the Postman collection.

| Area | Endpoints | Notes |
|---|---|---|
| Products | `GET /catalog/admin/products?status=&category=&q=&page=`, `GET /catalog/admin/products/{id}`, `POST /catalog/admin/products`, `PUT /catalog/admin/products/{id}` | PUT must send back the product's `version`; 409 means someone else saved first, so reload |
| Product fields | `taxCategory`: `produce`, `grocery`, `supplement`, `skin_care`, `soap`, `prepared`, `general` · `regulatoryClass`: `COSMETIC`, `WHOLE_PRODUCE`, `COTTAGE_FOOD`, `TCS`, `OTHER` · `status`: `DRAFT`, `ACTIVE`, `ARCHIVED` | Cosmetic, cottage-food and TCS products need `label.ingredients` before going ACTIVE |
| Inventory | `POST /catalog/admin/products/{id}/inventory { variantId, delta, reason, note? }` | `reason`: `RESTOCK`, `COUNT_CORRECTION`, `DAMAGED`, `MARKET_SALE`, `OTHER` |
| Images | `POST /catalog/admin/images/sign` → `{ uploadUrl, fields }` | POST the file plus `fields` as form data straight to `uploadUrl`, then save the returned `public_id` in the product's `images` |
| Categories | `GET /catalog/admin/categories`, `PUT /catalog/admin/categories/{slug}` | |
| Promo codes | `GET /promotions/admin?state=&q=`, `POST /promotions/admin`, `GET` / `PUT /promotions/admin/{id}`, `GET /promotions/admin/{id}/redemptions` | Types: `PERCENT`, `FIXED`, `FREE_DELIVERY`, `FREE_SHIPPING` |
| Orders | `GET /orders/admin?deliveryDate=&method=&groupStatus=&status=&q=`, `GET /orders/admin/{orderNumber}` | `deliveryDate` gives the Tue/Thu run sheet |
| Order status | `PUT /orders/admin/{orderNumber}/groups/{groupId} { status, trackingNumber?, trackingUrl? }` | Staff move forward one step; Admins can also move back. SHIPPED, ready-for-pickup, out-for-delivery and cancelled email the customer |
| Refunds | `POST /orders/admin/{orderNumber}/refunds { amountCents?, reason?, note?, restock? }` | No `amountCents` refunds everything left; `restock: [{ variantId, qty }]` puts items back in stock; emails the customer |
| Roles | `POST /auth/admin/users/role { email, role }` | Admins only. `role`: `CUSTOMER`, `STAFF`, `ADMIN`; you can't change your own |
