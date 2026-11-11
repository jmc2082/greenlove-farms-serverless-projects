# GreenLove Farms — Serverless Backend Architecture (Phase 1)

Status: draft · 2026-10-27

> **Update 2026-11-10:** payments use **Stripe** (Payment Element) and sales tax uses Stripe Tax; Square is gone. The checkout sections below describe the Stripe flow as built. See [roadmap-and-status.md](roadmap-and-status.md) for current status and decisions.

Business rules: `greenlove-farms-nuxtjs/docs/brainstorming-docs/` (Fulfilment Model, Cart/Checkout Scenarios).
Reference implementation: `event-robin/code/backends/eventrobin-serverless-projects`.

---

## 1. Principles

- **One Cart → One Checkout → One Payment → One Order → Many Fulfillment Groups.**
- **The server prices everything.** Nuxt displays totals; the `checkout` stack recomputes products, variants, discounts, delivery, shipping and tax before charging.
- **Our MongoDB is the system of record** for catalog, orders and (Phase 2) production. Stripe handles payments and sales tax only; products are not mirrored into Stripe.
- **Model all four fulfillment classes now**, even though Phase 1 only sells `STOCKED` goods plus Tue/Thu delivery and pickup.
- **Money is integer cents. Times are stored UTC; schedule logic runs in `America/Chicago`.**

## 2. Stack & services

| Concern | Choice |
|---|---|
| IaC / runtime | AWS SAM, TypeScript (esbuild), Node.js 20, arm64, us-east-2 |
| API | API Gateway HTTP API per stack, behind one custom domain with base-path mappings |
| Auth | Cognito (groups: `Customers`, `Staff`, `Admins`); guest checkout allowed |
| Database | MongoDB Atlas |
| Payments | Stripe: Payment Element in the browser, PaymentIntents created by the server, webhooks create orders. Stripe Tax for sales tax |
| Images | Cloudinary (signed direct uploads) |
| Email | AWS SES in the existing OarsLand LLC account (parent company); GreenLove sends from its own verified domain — see §2.1 |
| Scheduling | EventBridge Scheduler (cutoffs, abandoned-cart sweeps), timezone `America/Chicago` |
| Secrets | SSM SecureString (`/greenlove/{env}/...`), read at cold start |
| AWS profile | `jm_ubuntu_thinkpad_user` — set in every `samconfig.toml` section |

### 2.1 Email (SES)

GreenLove Farms LLC is a subsidiary of OarsLand LLC; SES is shared in the OarsLand AWS account, which already has `oarsland.com` verified.

- Verify `greenlove-farms.com` as a domain identity (Easy DKIM + custom MAIL FROM `mail.greenlove-farms.com`) in the same region as the Lambdas.
- Senders: `GreenLove Farms <orders@greenlove-farms.com>` (transactional), `GreenLove Farms <hello@greenlove-farms.com>` (marketing); reply-to a monitored inbox.
- Separate configuration sets (or an SES Tenant) for GreenLove: `greenlove-transactional-{env}`, `greenlove-marketing-{env}`, so reputation and bounce/complaint events are isolated from other OarsLand brands.
- DMARC on both `greenlove-farms.com` and `oarsland.com` (start `p=none`, move to `quarantine`).
- Footer: "GreenLove Farms LLC" + postal address; unsubscribe link on marketing mail.
- Sender, reply-to and configuration set are per-env parameters (SSM), never hard-coded. Interim/dev fallback: `GreenLove Farms <greenlove@oarsland.com>`.

## 3. Environments

| | dev | prod |
|---|---|---|
| Stack suffix | none (`greenlove-catalog`) | `-prod` |
| Mongo database | `greenlove_dev` | `greenlove_prod` |
| Mongo user | scoped to `greenlove_dev` only | scoped to `greenlove_prod` only |
| Stripe | Sandbox (test keys) | Live mode |
| Cloudinary folder | `greenlove/dev/` | `greenlove/prod/` |
| API domain | `api-dev.greenlove-farms.com` | `api.greenlove-farms.com` |

Separate databases (not collection prefixes) so a bug or misconfigured env can't read or write the other environment's data.

## 4. Repository layout

```
greenlove-farms-serverless-projects/
  docs/
  domain-infra/     deployed ONCE (not per env): SES greenlove-farms.com identity + DKIM/MAIL FROM/DMARC
                    records, ACM certs + API custom domains (api., api-dev.) — all in the existing Route 53 zone
  shared-infra/     Lambda layer (mongo, responses, jwt, money, dates), API domain, SSM params
  auth/             Cognito pool (emails via SES), groups, post-confirmation links the guest customer record
                    by verified email; /signup never writes to Mongo
  catalog/          products, variants, fulfillment profiles, inventory (+ adjustment log), Cloudinary upload
                    signing (product images only in Phase 1, so no separate images stack)
  carts/            server-side carts, product views, watchlist
  checkout/         quote engine, stock holds, Stripe PaymentIntents and Tax, order creation (Stripe webhook)
  promotions/       promo codes: staff create/edit/pause, redemption history, the cart's quick code check
  orders/           order history, guest tracking links and lookup email, staff list, status changes, refunds
  notifications/    shopper emails from order events (no API): confirmation, status updates, refunds; confirmation sweep
  notifications/    SES templates, transactional sends, abandoned-cart sweep
```

Products carry a `version` bumped by every write that touches variants (edits, inventory, checkout holds); updates must send the version they read (409 otherwise). Perishable or `TCS` products can never include `SHIP`. In Phase 1 only `STOCKED` products can be `ACTIVE`; the other classes stay `DRAFT` until checkout supports them. Images are Cloudinary public IDs under `greenlove/{env}/products/`.

Each stack: `template.yaml`, `samconfig.toml` (default/dev/prod), `package.json`, `tsconfig.json`, `.env.example`, `src/handlers`, `src/lib`. Shared helpers live **only** in the layer — no copies in stack `src/lib`.

## 5. Domain model (MongoDB collections)

### `products`
```ts
{
  _id, slug, name, description,
  shortDescription, searchTerms: string[], storage,  // card text, search synonyms, storage/shelf life
  label?: { ingredients, allergens: string[], statement? },
  featuredRank: number,                             // higher first in the Featured sort; 0 = not featured
  badges: ('NEW' | 'BESTSELLER' | 'LIMITED' | 'SEASONAL' | 'STAFF_PICK')[],
  category,                                         // a categories.slug
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
  fulfillmentClass: 'STOCKED' | 'MADE_TO_ORDER' | 'GROW_TO_ORDER' | 'CROP_RESERVATION',
  fulfillmentProfile: {
    methods: ('SHIP' | 'LOCAL_DELIVERY' | 'PICKUP')[],
    handlingDays?: number,                          // STOCKED
    leadTimeDays?: { min: number; max: number },    // GROW_TO_ORDER
    perishable: boolean,
  },
  regulatoryClass: 'COSMETIC' | 'WHOLE_PRODUCE' | 'COTTAGE_FOOD' | 'TCS' | 'OTHER',
  taxCategory: string,                              // maps to a rate in settings
  images: { publicId: string; alt: string }[],
  variants: [{
    _id, sku, name, priceCents, weightOz, netWeight?,  // weightOz is for shipping; netWeight is label text
    inventory?: { onHand: number; held: number },   // STOCKED only
  }],
  createdAt, updatedAt,
}
```
`regulatoryClass` and `fulfillmentProfile.methods` decide eligibility (e.g. TCS/perishable → no `SHIP`). `COSMETIC`, `COTTAGE_FOOD` and `TCS` products need `label.ingredients` before they can be `ACTIVE`, and `COTTAGE_FOOD` also needs `label.statement`.

### `categories`
```ts
{ _id, slug, name, blurb, image?: { publicId, alt }, sortOrder: number, status: 'ACTIVE' | 'HIDDEN', createdAt, updatedAt }
```
Products point at a category by slug, so a category's slug never changes. Retire one by setting it `HIDDEN`.

### `customers`
One per email; optionally linked to a Cognito user.
```ts
{ _id, email (unique, lowercased), cognitoSub?, fullName, phone,
  addresses: [{ label, line1, line2, city, state, zip, geo: { lat, lng }, deliveryInstructions }],
  consent: { marketingEmail: { granted, at, source }, sms: { granted, at, source } },
  createdAt, updatedAt }
```

### `carts`
```ts
{ _id: cartId (uuid, stored client-side), customerId?, email?,
  items: [{ productId, variantId, qty, addedAt }],
  status: 'ACTIVE' | 'CHECKING_OUT' | 'CONVERTED' | 'ABANDONED',
  abandonedEmailSentAt?, updatedAt, expiresAt }   // TTL index on expiresAt
```
Carts never reserve stock. Anonymous cart merges into the customer cart on login (claimed outright if the customer has no active cart, otherwise lines folded in and the anonymous cart marked `MERGED`). A cart linked to a customer is reachable only via `/me/cart` — never by its `cartId` — so a cartId left in a logged-out browser can't reopen it. At most one `ACTIVE` cart per customer (unique partial index). TTL: 30 days after last write, 7 days for a never-used cart. `contact` (guest email + consent) is stored on the cart only, never on `customers`, because that endpoint is unauthenticated.

### `productViews` (TTL ~90 days) and `watchlist`
`{ cartId?, customerId?, productId, viewedAt }` · `{ customerId | email, productId, createdAt }`

### `checkoutQuotes` (TTL 1 day; 30 days once paying)
Every `POST /checkout/quote` saves one: the shopper's inputs (contact, address, method per group, date), the priced
groups and totals, any `issues`, the Stripe Tax calculation per group, and a `fingerprint` of everything the shopper
pays for. `/pay` re-prices from the saved inputs and refuses (409 with the new quote) if the fingerprint changed.
Tax calculations are reused across quotes for the same cart when the inputs are identical.

### `checkoutHolds`
Stock set aside between "Place order" and the payment result: `inventory.held` is raised per variant (optimistic
`version` check, all-or-nothing). `HELD` → `COMMITTED` (paid: onHand and held both drop) or `RELEASED`. Not a TTL
collection: the `sweep-holds` function (every 5 minutes) cancels the abandoned PaymentIntent and gives the stock back
after `holdMinutes` (30); a hold whose payment is processing or already succeeded is extended instead.

### `orders`
Created only by the `payment_intent.succeeded` webhook, so every order is paid. Type: `Order` in the shared layer.
```ts
{ _id, orderNumber: 'GLF-2026-000182', customerId, placedBy: 'GUEST' | 'CUSTOMER',
  contact: { fullName, email, phone },
  status: 'PAID' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED',
  totals: { subtotalCents, discountCents, deliveryCents, shippingCents, taxCents, totalCents },
  promotion?: { promotionId, code, discountCents, feeDiscountCents },
  payment: { provider: 'STRIPE', paymentIntentId (unique), status, amountCents, currency, method?: { type, brand, last4 }, refundedCents },
  tax: { calculationIds, transactionIds },          // Stripe Tax; transactions are what filing reports use
  fulfillmentGroups: [{
    _id, fulfillmentClass, method: 'SHIP' | 'LOCAL_DELIVERY' | 'PICKUP',
    status: 'SCHEDULED' | 'PREPARING' | 'IN_PRODUCTION' | 'READY' | 'SHIPPED'
          | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'PICKED_UP' | 'CANCELLED',
    items: [{ productId, variantId, name, variantName, sku, qty, unitPriceCents, discountCents, taxCents, lineTotalCents }],
    pickupLocation?, address?, deliveryDate?, shipsWithinDays?, feeCents, taxCents,
    trackingNumber?, trackingUrl?, statusHistory: [{ status, at, by? }]
  }],
  quoteId, cartId, inventory: { committedAt, short }, guestAccessTokenHash,
  notifications: { confirmationSentAt, sent: [{ key, claimedAt, sentAt, messageId }] }, refunds?,
  createdAt, updatedAt }
```
Guests get a `customers` record keyed by email (`cognitoSub: null`), so signing up later with that email links the orders.
`inventory.short` flags an order paid after its hold expired when stock ran out meanwhile, for staff to review.

**After the order** (`orders` stack). `{ref}` is the order number or id.
- *Status:* each group follows its method's path: ship `PREPARING → SHIPPED → DELIVERED`; local delivery
  `SCHEDULED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED`; pickup `SCHEDULED → PREPARING → READY → PICKED_UP`;
  any unfinished group can be `CANCELLED`. Staff move forward only (skipping steps is fine); Admins can also correct
  backwards. Each change is appended to `statusHistory` with who made it. The order's `status` follows its groups
  (`PAID → PARTIALLY_FULFILLED → FULFILLED`, or `CANCELLED`), and becomes `REFUNDED` once fully refunded.
- *Refunds:* `stripe.refunds.create` (whole remainder by default), then a Stripe Tax reversal per tax transaction
  (full, or the same share for a partial refund), optional restock (logged in `inventoryAdjustments` as
  `REFUND_RESTOCK`), and a `refunds[]` entry. Idempotency keys are tied to the order's refunded total so a
  double-click can't refund twice. Refunds made in the Stripe Dashboard reach the checkout webhook as
  `refund.created`; it hands them to the orders stack (`StripeRefundCreated`), which records them the same way but
  without restocking. Staff refunds carry `metadata.source=admin` and are skipped there; tax reversals are keyed by
  refund id and `recordRefund` checks the refund id, so no refund is ever recorded or reversed twice.
- *Guest links:* a random 32-byte token, stored only as its sha256 in `guestAccessTokenHash`; a new link replaces
  the old one. `POST /orders/lookup` answers 202 either way and only emails the link to the order's address.
- *Emails to shoppers* (`notifications` stack): checkout publishes `OrderPaid` and orders publishes
  `FulfillmentStatusChanged` / `RefundIssued` (`publishEvent`, default EventBridge bus, `detail.environment` set;
  publishing never fails the caller). The `order-emails` function sends the confirmation (guests: a new tracking
  link; account holders: `/account/orders/{orderNumber}`), emails for `SHIPPED`, `READY` (pickup), `OUT_FOR_DELIVERY`
  and `CANCELLED`, and a refund notice. Later guest emails don't mint a new link (that would break the one in the
  confirmation). Each email claims a key in `notifications.sent` (`confirmation`, `status:<groupId>:<status>`,
  `refund:<refundId>`) before sending, so a repeated event can't send twice; a failure releases the claim and the event
  is retried (EventBridge, up to 6 hours). `confirmation-sweep` (every 15 minutes) sends confirmations still missing
  after 5 minutes, for orders up to 3 days old. Reserved test domains (example.com, .test, …) are never emailed.
- *Email:* `sendEmail` and `emailLayout` in the shared layer send through SES with the transactional configuration
  set; links use the stack's `WebUrl` (`http://localhost:3000` on dev, `https://www.greenlove-farms.com` on prod).

### `promotions` and `promotionRedemptions`
```ts
{ _id, code: 'SPRING10' (uppercase, unique), description,             // description is staff-facing
  type: 'PERCENT' | 'FIXED' | 'FREE_DELIVERY' | 'FREE_SHIPPING', value, // percent 1–100 or cents
  appliesTo: { scope: 'ORDER' | 'CATEGORIES' | 'PRODUCTS' | 'FULFILLMENT_CLASSES', ids },
  minSubtotalCents, maxDiscountCents, startsAt, endsAt, usageLimit, perCustomerLimit, firstOrderOnly,
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED', redemptionCount, version, createdBy, updatedBy, createdAt, updatedAt }
// promotionRedemptions: { promotionId, code, orderId, orderNumber, customerId, email, discountCents, feeDiscountCents, createdAt }
```
One code per order. The quote applies it (shared `evaluatePromotion`): status, dates, minimum (order subtotal before
discounts), scope, total and per-customer limits (per account, or per email for guests), first-order-only. Percent and
fixed discounts are split across eligible items by line total (exact to the cent) and applied **before tax**; free
delivery / free shipping waive that fee. A code that doesn't apply comes back with its reason and doesn't block payment.
`/pay` re-checks everything; the webhook records the redemption (unique per order) and increments `redemptionCount`,
so a failed payment never uses up a code. Two checkouts paying at the same moment can both pass a nearly used-up
`usageLimit`; acceptable at our volume. A code can't be renamed after it has been used.

### Supporting
- `counters` — `{ _id: 'order-2026', seq }` via `findOneAndUpdate` + `$inc`.
- `settings` — `{ _id: 'checkout' }` overrides the defaults in `checkout/src/lib/settings.ts`: local delivery fee ($8.95, free from $40), delivery-area ZIPs, shipping rate, pickup farms, Stripe tax code per `taxCategory`, hold and quote minutes. The Tue/Thu schedule and cutoffs live in the shared layer's `delivery.ts`.
- `webhookEvents` — Stripe event ids (dedupe; TTL 30 days).
- `emailLog` — sends, template, SES message id, bounce/complaint state.

## 6. Checkout flow

Each route exists for guests (`/checkout/...`, `cartId` in the body) and signed-in shoppers (`/checkout/me/...`, Cognito JWT).

1. `POST /checkout/quote` — called on every checkout change. Prices the cart from the catalog, splits it into
   fulfillment groups (one per class; Phase 1 sells only `STOCKED`), offers the methods every item in a group supports,
   lists upcoming Tue/Thu dates past their cutoffs, adds fees, checks the delivery area, and calls Stripe Tax once every
   group has an address. Shopper problems come back as `issues` (HTTP 200); `payable` is true when there are none.
2. The browser mounts the Payment Element with the quote's amount (no PaymentIntent yet).
3. `POST /checkout/pay { quoteId }` — re-prices; 409 with the new quote if anything changed (or stock ran out).
   Otherwise holds the stock and creates the PaymentIntent (idempotency key per hold, `metadata.quoteId`/`holdId`),
   returning `clientSecret`. Repeating the call returns the same open payment.
4. The browser calls `stripe.confirmPayment()`; Stripe handles 3-D Secure and redirects to the confirmation page.
5. `POST /checkout/webhooks/stripe` — signature-verified, deduplicated. Events: `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.created`. `payment_intent.succeeded` creates the order,
   commits the stock, marks the cart `CONVERTED` and records the Stripe Tax transaction. `payment_failed` keeps the hold
   (the shopper can retry); `canceled` releases it.
6. `GET /checkout/status?paymentIntent=&clientSecret=` — the confirmation page polls until the order exists.

## 7. Phase 1 endpoints (initial list)

| Stack | Public | Authenticated / Admin |
|---|---|---|
| catalog | `GET /products` (`q`, `sort`, `category`, `fulfillmentClass`, `methods`, `minPrice`/`maxPrice` in cents, `inStock`, `page`, `limit`), `GET /products/suggest?q=`, `GET /products/{slug}`, `GET /categories` | Staff: `GET/POST /admin/products`, `GET/PUT /admin/products/{id}` (PUT needs `version`), `POST /admin/products/{id}/inventory`, `POST /admin/images/sign`, `GET /admin/categories`, `PUT /admin/categories/{slug}` |
| carts | `POST /carts/new`, `GET /carts/{cartId}`, `PUT /carts/{cartId}/items`, `DELETE /carts/{cartId}/items/{variantId}`, `PUT /carts/{cartId}/contact`, `POST/GET /carts/{cartId}/views` | Customer: `GET /me/cart`, `PUT /me/cart/items`, `DELETE /me/cart/items/{variantId}`, `POST /me/cart/merge` (also moves guest views), `POST/GET /me/views`, `GET /me/watchlist`, `PUT/DELETE /me/watchlist/{productId}` |
| checkout | `POST /checkout/quote` (`promoCode` optional), `POST /checkout/pay`, `GET /checkout/status`, `POST /checkout/webhooks/stripe` | Customer: `POST /checkout/me/quote`, `POST /checkout/me/pay` |
| promotions | `POST /promotions/check` (throttled) | Staff: `GET/POST /promotions/admin` (`state`, `q`), `GET/PUT /promotions/admin/{id}` (PUT needs `version`; pause/resume/archive via `status`), `GET /promotions/admin/{id}/redemptions` |
| orders | `GET /orders/track?token=`, `POST /orders/lookup` (both throttled) | Customer: `GET /orders/me`, `GET /orders/me/{ref}`; Staff: `GET /orders/admin` (`deliveryDate`, `method`, `groupStatus`, `status`, `q`, `inventoryShort`), `GET /orders/admin/{ref}`, `PUT /orders/admin/{ref}/groups/{groupId}`, `POST /orders/admin/{ref}/refunds` |
| auth | `POST /signup`, `/confirm-signup`, `/resend-code`, `/login`, `/refresh`, `/forgot-password`, `/confirm-password` | Customer: `GET/PUT /me`, `GET/POST /me/addresses`, `PUT/DELETE /me/addresses/{id}`; Admin: `POST /admin/users/role` |
| notifications | — | internal only (invoked by other stacks / scheduler) |

## 8. Frontend integration (greenlove-farms-nuxtjs)

- Nuxt 4 on AWS Amplify (app `greenlove-farms-nuxtjs`); Route 53 zone `greenlove-farms.com` (Z0308600QSM583WB058K) is in the same AWS account (218334699468), alongside other OarsLand brands.
- Amplify app `greenlove-farms-nuxtjs` has only `main` (→ `api.greenlove-farms.com`). Dev frontend runs on localhost; add an Amplify `dev` branch later if needed.
- Replace the hard-coded `CURRENT_ENV` in `configs/configs.ts` with `runtimeConfig.public.apiBase` (`NUXT_PUBLIC_API_BASE` per Amplify branch).
- `useHttpRequests` sends `x-access-token`; this backend expects `Authorization: Bearer <Cognito JWT>`.
- CORS allow-list: `https://greenlove-farms.com`, `https://www.greenlove-farms.com`, `http://localhost:3000`.
- Contact form stays on `api.oarsland.com/contacts` for now.

## 9. Open items

- Confirm Texas sales-tax treatment per `taxCategory` (cosmetics vs. food vs. juice) with an accountant.
- Map each product to `regulatoryClass` (cottage food / TCS rules for juice, cut greens, microgreens).
- Geocoding provider (Amazon Location Service vs. Google).
- SES: confirm the OarsLand account is out of the sandbox in the Lambda region; verify `greenlove-farms.com`; add DMARC to `oarsland.com`.
- Atlas tier and connection limits for Lambda concurrency.
- `git init` the repo.
