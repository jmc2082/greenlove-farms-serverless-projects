# GreenLove Farms — Serverless Backend Architecture (Phase 1)

Status: draft · 2026-10-27

Business rules: `greenlove-farms-nuxtjs/docs/brainstorming-docs/` (Fulfilment Model, Cart/Checkout Scenarios).
Reference implementation: `event-robin/code/backends/eventrobin-serverless-projects`.

---

## 1. Principles

- **One Cart → One Checkout → One Payment → One Order → Many Fulfillment Groups.**
- **The server prices everything.** Nuxt displays totals; the `checkout` stack recomputes products, variants, discounts, delivery, shipping and tax before charging.
- **Our MongoDB is the system of record** for catalog, orders and (Phase 2) production. Square is the payment/POS system.
- **Model all four fulfillment classes now**, even though Phase 1 only sells `STOCKED` goods plus Tue/Thu delivery and pickup.
- **Money is integer cents. Times are stored UTC; schedule logic runs in `America/Chicago`.**

## 2. Stack & services

| Concern | Choice |
|---|---|
| IaC / runtime | AWS SAM, TypeScript (esbuild), Node.js 20, arm64, us-east-2 |
| API | API Gateway HTTP API per stack, behind one custom domain with base-path mappings |
| Auth | Cognito (groups: `Customers`, `Staff`, `Admins`); guest checkout allowed |
| Database | MongoDB Atlas |
| Payments | Square (Web Payments SDK → Payments API, Orders API, webhooks) |
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
| Square | Sandbox | Production |
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
  catalog/          products, variants, fulfillment profiles, inventory, Square catalog import
  images/           Cloudinary signing + image refs
  carts/            server-side carts, product views, watchlist
  checkout/         quote engine, holds, Square payment, order creation, Square webhooks
  orders/           order + fulfillment-group reads and admin status changes, guest lookup
  notifications/    SES templates, transactional sends, abandoned-cart sweep
```

Each stack: `template.yaml`, `samconfig.toml` (default/dev/prod), `package.json`, `tsconfig.json`, `.env.example`, `src/handlers`, `src/lib`. Shared helpers live **only** in the layer — no copies in stack `src/lib`.

## 5. Domain model (MongoDB collections)

### `products`
```ts
{
  _id, slug, name, description, category,
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
    _id, sku, name, priceCents, weightOz,
    inventory?: { onHand: number; held: number },   // STOCKED only
    squareVariationId?: string,
  }],
  squareItemId?: string,
  createdAt, updatedAt,
}
```
`regulatoryClass` and `fulfillmentProfile.methods` decide eligibility (e.g. TCS/perishable → no `SHIP`).

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
Carts never reserve stock. Anonymous cart merges into the customer cart on login.

### `productViews` (TTL ~90 days) and `watchlist`
`{ cartId?, customerId?, productId, viewedAt }` · `{ customerId | email, productId, createdAt }`

### `checkoutHolds` (TTL ~15 min)
Short-lived reservation of inventory (Phase 2: juice slot / crop capacity) between quote and payment. Released on expiry or payment failure via atomic `$inc` on `variants.inventory.held`.

### `orders`
```ts
{ _id, orderNumber: 'GLF-2026-000182', customerId, contact: { fullName, email, phone },
  status: 'PENDING_PAYMENT' | 'PAID' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED',
  totals: { subtotalCents, discountCents, deliveryCents, shippingCents, taxCents, totalCents },
  payment: { provider: 'SQUARE', squarePaymentId, squareOrderId, idempotencyKey, status },
  fulfillmentGroups: [{
    _id, fulfillmentClass, method: 'SHIP' | 'LOCAL_DELIVERY' | 'PICKUP',
    status: 'SCHEDULED' | 'IN_PRODUCTION' | 'READY' | 'READY_FOR_LABEL' | 'SHIPPED'
          | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'PICKED_UP' | 'CANCELLED',
    items: [{ productId, variantId, name, sku, qty, unitPriceCents }],
    address?, deliveryDate?, estimatedReady?: { from, to }, trackingNumber?, statusHistory: [...]
  }],
  guestAccessToken (hashed), createdAt, updatedAt }
```

### Supporting
- `counters` — `{ _id: 'order-2026', seq }` via `findOneAndUpdate` + `$inc`.
- `settings` — delivery days, cutoffs (Sun 18:00 → Tue, Tue 18:00 → Thu), zone (77070, 25 mi), fees ($40 minimum / $8.95 under), tax rates.
- `webhookEvents` — Square event ids processed (dedupe).
- `emailLog` — sends, template, SES message id, bounce/complaint state.

## 6. Checkout flow

1. `POST /checkout/quote` — cart + contact + method(s) + address → server validates eligibility, geocodes and checks radius, splits into fulfillment groups, computes dates and totals. Returns quote id + breakdown (the "your order ships in parts" view).
2. Browser tokenizes card with Square Web Payments SDK.
3. `POST /checkout/pay` — quote id + card token → re-validate, create `checkoutHolds`, create Square Order + Payment (idempotency key = quote id), on success write `orders`, commit inventory, mark cart `CONVERTED`, emit confirmation email. On failure release holds.
4. `POST /checkout/webhooks/square` — signature-verified; reconciles payment/refund state.

## 7. Phase 1 endpoints (initial list)

| Stack | Public | Authenticated / Admin |
|---|---|---|
| catalog | `GET /products`, `GET /products/{slug}` | Admin: CRUD products/variants, adjust inventory, `POST /admin/square/import` |
| images | — | Admin: `POST /images/sign` |
| carts | `POST /carts`, `GET/PUT /carts/{id}`, `POST /carts/{id}/items`, `POST /views`, `POST /watchlist` | Customer: `POST /carts/{id}/merge` |
| checkout | `POST /checkout/quote`, `POST /checkout/pay`, `POST /checkout/webhooks/square` | — |
| orders | `GET /orders/lookup?token=` | Customer: `GET /me/orders`; Admin: list/filter by delivery day, update fulfillment-group status, refund |
| auth | `POST /signup`, `/confirm-signup`, `/resend-code`, `/login`, `/refresh`, `/forgot-password`, `/confirm-password` | Customer: `GET/PUT /me`; Admin: `POST /admin/users/role` |
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
