# Backend roadmap and status

Last updated: 2026-11-10

This page tracks what the backend has, what's deployed where, and what's next. For how the system is designed, see [architecture.md](architecture.md). The website's plan (pages, checkout screens, build order) lives in the frontend repo: `greenlove-farms-nuxtjs/docs/product-roadmap/` (start with `phases.md` and `ecommerce-spec.md`).

Status key: ✅ done · 🟡 in progress · ⬜ not started

---

## Where things stand

- **Customer accounts work on both dev and prod.** Sign-up, email code, login, token refresh, password reset and `/me` all run on Cognito. The website was switched over to them on 2026-11-09.
- **Catalog and carts are deployed on both environments.** The prod catalog is empty, which is expected because no products have been added yet.
- **Checkout and promo codes work on dev with Stripe test payments.** A paid checkout creates the order, takes the stock, records the sale in Stripe Tax and counts the promo code's use. Orders (history, tracking, refunds) and confirmation emails are still to come, and online ordering can't open until they're done.
- **Sales tax is $0 for now.** Stripe Tax is set up, but no state registration exists yet, so it calculates tax and collects none. Register Texas before launch (see "Still to do outside the code"); no code change is needed when that happens.
- **Payments moved from Square to Stripe.** [architecture.md](architecture.md) still describes Square in several places. Where the two disagree, this page and the frontend's `ecommerce-spec.md` are current.

### Deployed stacks

| Stack | Dev | Prod | Base URL |
|---|---|---|---|
| `domain-infra` (shared by both) | ✅ | ✅ | |
| `shared-infra` | ✅ | ✅ | |
| `auth` | ✅ | ✅ | `https://api[-dev].greenlove-farms.com/auth` |
| `catalog` | ✅ | ✅ (2026-11-09) | `.../catalog` |
| `carts` | ✅ | ✅ (2026-11-09) | `.../carts` |
| `checkout` | ✅ (2026-11-10) | ⬜ | `.../checkout` |
| `promotions` | ✅ (2026-11-10) | ⬜ | `.../promotions` |
| `orders` | ✅ (2026-11-10) | ⬜ | `.../orders` |
| `notifications` | ⬜ | ⬜ | |

Prod health checks (`/auth/health`, `/catalog/health`, `/carts/health`) all return 200.

### Databases (MongoDB Atlas)

| | Dev | Prod |
|---|---|---|
| Database | `greenlove_dev` | `greenlove_prod` |
| Atlas user | `greenlove_dev_user` (readWrite on `greenlove_dev` only) | `greenlove_prod_user` (readWrite on `greenlove_prod` only) |
| Connection string | SSM `/greenlove/dev/mongodb-uri` | SSM `/greenlove/prod/mongodb-uri` |
| Indexes | ✅ auth, catalog (incl. categories), carts, checkout, promotions | ✅ auth, catalog, carts (categories, checkout and promotions: not yet) |

Each environment's user can open only its own database, so a dev test can never change prod data.

### Settings stored in SSM

| Setting | Dev | Prod |
|---|---|---|
| `mongodb-uri` | ✅ | ✅ |
| `cloudinary-url` | ✅ | ⬜ **needed before uploading product images on prod** |
| `stripe-secret-key`, `stripe-webhook-secret` | ✅ (sandbox) | ⬜ live keys, then `./scripts/put-stripe-secrets.sh prod` |
| Cognito ids, SES senders and config sets, layer ARN, API domain | ✅ (created by the stacks) | ✅ |

---

## What's been done

| Date | Work |
|---|---|
| 2026-10-27 | Architecture drafted ([architecture.md](architecture.md)). |
| 2026-10-30 | `domain-infra`, `shared-infra` and `auth` deployed to dev and prod. Cognito with Customers / Staff / Admins groups, emails sent through SES. |
| 2026-11-02 to 11-03 | `catalog` (public product reads, staff product management, inventory, Cloudinary upload signing) and `carts` (guest and signed-in carts, merge on login, product views, watchlist) deployed to dev. |
| 2026-11-09 | Website switched to Cognito accounts. Decided on Stripe instead of Square, Stripe Tax, promo codes, and Atlas Search for product search. |
| 2026-11-09 | Fixed prod sign-up: confirming the email code returned a 500 error because the prod database connection string was missing from SSM. Added separate Atlas users for dev and prod, created the prod indexes, and restored the customer record for the first prod account. |
| 2026-11-09 | Deployed `catalog` and `carts` to prod. Added `scripts/with-db.sh`. `deploy.sh` now accepts `AWS_PROFILE`. |
| 2026-11-10 | On dev: recently viewed (guest views carry over at login) and saved addresses with ids and a default. Addresses saved earlier get ids the first time they're read. |
| 2026-11-10 | Catalog on dev: search (Atlas Search, with typo tolerance and synonyms), suggestions, sorting (featured, newest, price), price / delivery-method / in-stock filters, and availability on every product. The shared database connection no longer uses MongoDB's strict API mode, which blocks Atlas Search. Made the first prod admin. |
| 2026-11-10 | New `orders` stack on dev: order history and order detail for signed-in shoppers (`/orders/me`, including orders they placed as a guest with the same email), guest tracking links (`/orders/track?token=`) and email lookup (`POST /orders/lookup` emails a fresh link; the first email sent by the app), staff order list (by delivery day, method, status, search, stock shortfalls), status updates per fulfillment group with history, and refunds (Stripe refund, Stripe Tax reversal, optional restock). Shared layer: `sendEmail` and a branded email layout. SES production access confirmed. Paths are `/orders/me...` rather than the spec's `/me/orders...`. Postman: 509 checks, all passing. |
| 2026-11-10 | New `promotions` stack on dev: staff create, edit, pause/resume and archive codes, list them by state (active, scheduled, expired, paused, archived), see redemptions; public `POST /promotions/check` for the cart. Checkout quote takes `promoCode`: percent, fixed, free delivery and free shipping codes, limited by dates, minimum, items, total uses, uses per customer and first order only, applied before tax. The webhook records each use. Paths are `/promotions/admin...` rather than the spec's `/admin/promotions...` because each stack has its own base path. Postman: 442 checks, all passing. |
| 2026-11-10 | New `checkout` stack on dev: quote (pricing, fulfillment groups, Tue/Thu dates, delivery and shipping fees, delivery-area check, Stripe Tax), pay (re-price, hold stock, create the PaymentIntent), Stripe webhook (creates the order, takes the stock, records the tax transaction), payment status, and a 5-minute sweep that releases stock from abandoned payments. Tested with Stripe test cards: success, decline then retry, changed cart, abandoned payment. Postman covers guest and signed-in checkout (332 checks). Stripe sandbox connected: keys and webhook secret in SSM (`scripts/put-stripe-secrets.sh`), webhook registered. |
| 2026-11-09 | Catalog on dev: removed the Square fields, added the new product fields and the categories endpoints. Active cosmetic, cottage-food and TCS products now need ingredients on their label. |

---

## Decisions since the architecture doc

| Topic | Decision | Replaces |
|---|---|---|
| Payments | Stripe with the embedded Payment Element. The browser collects card details, and the server creates the PaymentIntent and sets the amount. Orders are created by the `payment_intent.succeeded` webhook. | Square Web Payments SDK |
| Sales tax | Stripe Tax: calculated in the quote, recorded when payment succeeds, reversed on refund. Food and juice are sold locally (Houston-area rates). Body care ships nationwide and uses each state's rules. | Rates kept in `settings` |
| Search | MongoDB Atlas Search (`q` on products, plus a suggestions endpoint). | Not planned before |
| Promo codes | `promotions` and `promotionRedemptions` collections, managed in an admin area. The server decides whether a code applies. | Not planned before |
| Launch range | Body care only. These are `STOCKED` products that can ship anywhere in the U.S. | |
| Runtime | Node.js 24 | Node.js 20 |

---

## Roadmap

### Phase 1: online store (body-care launch)

Backend items, roughly in order. The full list with details is in the frontend's `ecommerce-spec.md`, section 10.

| Item | Stack | Status |
|---|---|---|
| Cognito accounts, `/me`, admin roles | auth | ✅ |
| Product reads, staff product management, inventory, image upload signing | catalog | ✅ |
| Carts, merge on login, views, watchlist | carts | ✅ |
| Remove the Square fields from products | catalog | 🟡 on dev, not prod yet |
| Order payment info (`orders.payment`: PaymentIntent, card brand and last 4) | checkout | 🟡 on dev, not prod yet |
| Saved cards (`customers.stripeCustomerId`, CustomerSession) | auth, checkout | ⬜ open decision: at launch or soon after |
| New product fields: `searchTerms`, `shortDescription`, `label` (ingredients, allergens, statement), `storage`, `featuredRank`, `badges`; `netWeight` on each size | catalog | 🟡 on dev, not prod yet |
| `GET /categories`, plus staff `GET /admin/categories` and `PUT /admin/categories/{slug}` | catalog | 🟡 on dev, not prod yet |
| Product filters and sort: `q` (Atlas Search), `sort`, price range, delivery methods, `inStock` | catalog | 🟡 on dev, not prod yet |
| `GET /products/suggest?q=` | catalog | 🟡 on dev, not prod yet |
| Public availability for each product: stock status, how many are left, next delivery or pickup date and its order-by time, days to ship | catalog | 🟡 on dev, not prod yet |
| ZIP check (`zip=`) and "ready by" filter (`readyBy=`) | catalog | ⬜ deferred: ZIP needs a delivery-area lookup; "ready by" matters once grown and made-to-order products are sold (Phase 2) |
| Recently viewed: `GET /carts/{cartId}/views`, `GET /me/views` (`limit`, `exclude`); a guest's views move to the account when the cart merges at login | carts | 🟡 on dev, not prod yet |
| Saved addresses: `GET/POST /me/addresses`, `PUT/DELETE /me/addresses/{id}`, with ids and one default address | auth | 🟡 on dev, not prod yet |
| **Checkout:** quote, pay (create the PaymentIntent), Stripe webhook, status | checkout (new) | 🟡 on dev, not prod yet |
| **Stripe Tax** in the quote and recorded on payment | checkout | 🟡 on dev (collects $0 until a state is registered) |
| Stripe Tax reversal on refund | orders | 🟡 on dev, not prod yet |
| Checkout settings to confirm: shipping rate (placeholder $7.95 flat), delivery-area ZIPs (placeholder: starts with 770, 773 or 774), farm pickup addresses (placeholder ZIPs 77070 and 77301), Stripe tax code per `taxCategory` (all "general" for now). Change them in the `settings` document `{ _id: 'checkout' }`; defaults are in `checkout/src/lib/settings.ts`. | data | ⬜ |
| **Promo codes:** collections, admin create/edit/pause, redemptions, `POST /promotions/check`, applied in the quote | promotions (new), checkout | 🟡 on dev, not prod yet |
| **Orders:** `/orders/me`, guest tracking link and lookup, staff list, status changes, refunds | orders (new) | 🟡 on dev, not prod yet |
| Refunds made in the Stripe Dashboard (`charge.refunded` webhook) | orders | ⬜ until then, refund from the admin endpoint so tax and stock stay right |
| **Emails:** order confirmation, status updates, guest tracking link | notifications (new) | ⬜ |
| Classify every product's `regulatoryClass` | data | ⬜ |

### Phase 2: farm products

Microgreens grown to order (lead time to harvest date to delivery date), crop reservations with harvest windows, juice production slots with batch limits, and cleanse bundles.

### Phase 3: automation

Subscriptions (Microgreen Club, GreenLove Weekly, Juice Club), recurring orders and production forecasts, delivery routes, SMS updates, and QR codes for trays and batches.

### Phase 4: scale

Wholesale and restaurant standing orders, corporate juice delivery, farm-stand POS sync, and shipping automation.

---

## Still to do outside the code

- [x] Run the full Postman tests on dev: 509 checks, all passing (2026-11-10). Accounts: a dev customer and a dev admin (Gmail `+` aliases, the admin in the dev Admins group) in `.env` as `POSTMAN_TEST_*` and `POSTMAN_ADMIN_*`. Prod runs are read-only and have no test accounts yet.
- [ ] Deploy the dev work to prod: `AWS_PROFILE=jmplutouser2 ./deploy.sh prod shared-infra auth catalog carts checkout promotions orders`, then run the `catalog`, `carts`, `checkout`, `promotions` and `orders` index scripts on prod (`./scripts/with-db.sh prod -- npm --prefix catalog run indexes`, same with `carts`). That script also creates the `products_search` Atlas Search index, which Atlas takes about a minute to build.
- [ ] Create the categories (at least `body-care`) with `PUT /catalog/admin/categories/{slug}`.
- [ ] Add `/greenlove/prod/cloudinary-url` (needed before uploading product images on prod).
- [ ] Change the `oars_admin_user` Atlas password (it was exposed). Dev and prod no longer use that user.
- [ ] Optionally change the `greenlove_dev_user` and `greenlove_prod_user` passwords and save the new ones with `put-parameter --overwrite`.
- [x] Stripe sandbox: keys in dev SSM, webhook registered for `https://api-dev.greenlove-farms.com/checkout/webhooks/stripe` (done 2026-11-10).
- [ ] Stripe live mode before launch: register the prod webhook (`https://api.greenlove-farms.com/checkout/webhooks/stripe`, events `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`), put its signing secret and the live secret key in `.env`, then run `./scripts/put-stripe-secrets.sh prod`. Set the public business name and card-statement name to GreenLove Farms (Settings → Business → Public details).
- [ ] **Register for Texas sales tax** with the Texas Comptroller, then add the registration in Stripe (More → Tax → Registrations), first in the sandbox to test, then in live mode. Until then Stripe Tax collects $0. Confirm with an accountant how food, juice and cosmetics are taxed, and whether delivery fees are taxable.
- [ ] Stripe Tax's preset product category is "General - Electronically Supplied Services". Checkout sends a tax code with every line, so it isn't used, but change it to "General - Tangible Goods" so Dashboard-created charges match.
- [x] Make the first prod admin (done 2026-11-10).
- [x] SES has production access in us-east-2 (50,000 emails a day), so emails can reach any customer (checked 2026-11-10).

## Suggested hardening

These aren't required, but they'd prevent a repeat of the prod sign-up failure:

- If the post-confirmation trigger can't reach the database, it should log the error and still let the sign-up finish.
- `/me` and the carts stack should create a missing customer record when they need one.
- Use a shorter MongoDB connection timeout so a bad connection fails fast with a clear error.

---

## How to run things

```bash
# Deploy (on this Mac the profile isn't the one in samconfig.toml, so pass it)
AWS_PROFILE=jmplutouser2 ./deploy.sh dev
AWS_PROFILE=jmplutouser2 ./deploy.sh prod catalog carts

# Run a local tool against a database. Prod asks you to type "prod" first.
./scripts/with-db.sh dev  -- npm --prefix auth run indexes
./scripts/with-db.sh prod -- npm --prefix auth run indexes
```

- Deployed functions never read `.env`. They get their database from SSM and from `MongoDbName` in each stack's `samconfig.toml`.
- `.env` is for local tools only. It points at dev, and the prod lines stay commented out.
- If a sign-up confirmation fails on prod, check the CloudWatch log group `/aws/lambda/greenlove-auth-prod-post-confirmation` first.
