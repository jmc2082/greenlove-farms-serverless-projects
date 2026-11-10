# Backend roadmap and status

Last updated: 2026-11-09

This page tracks what the backend has, what's deployed where, and what's next. For how the system is designed, see [architecture.md](architecture.md). The website's plan (pages, checkout screens, build order) lives in the frontend repo: `greenlove-farms-nuxtjs/docs/product-roadmap/` (start with `phases.md` and `ecommerce-spec.md`).

Status key: ✅ done · 🟡 in progress · ⬜ not started

---

## Where things stand

- **Customer accounts work on both dev and prod.** Sign-up, email code, login, token refresh, password reset and `/me` all run on Cognito. The website was switched over to them on 2026-11-09.
- **Catalog and carts are deployed on both environments.** The prod catalog is empty, which is expected because no products have been added yet.
- **Checkout, orders and emails don't exist yet.** These are the next stacks, and online ordering can't open until they're done.
- **Payments moved from Square to Stripe.** [architecture.md](architecture.md) still describes Square in several places. Where the two disagree, this page and the frontend's `ecommerce-spec.md` are current.

### Deployed stacks

| Stack | Dev | Prod | Base URL |
|---|---|---|---|
| `domain-infra` (shared by both) | ✅ | ✅ | |
| `shared-infra` | ✅ | ✅ | |
| `auth` | ✅ | ✅ | `https://api[-dev].greenlove-farms.com/auth` |
| `catalog` | ✅ | ✅ (2026-11-09) | `.../catalog` |
| `carts` | ✅ | ✅ (2026-11-09) | `.../carts` |
| `checkout` | ⬜ | ⬜ | |
| `orders` | ⬜ | ⬜ | |
| `notifications` | ⬜ | ⬜ | |

Prod health checks (`/auth/health`, `/catalog/health`, `/carts/health`) all return 200.

### Databases (MongoDB Atlas)

| | Dev | Prod |
|---|---|---|
| Database | `greenlove_dev` | `greenlove_prod` |
| Atlas user | `greenlove_dev_user` (readWrite on `greenlove_dev` only) | `greenlove_prod_user` (readWrite on `greenlove_prod` only) |
| Connection string | SSM `/greenlove/dev/mongodb-uri` | SSM `/greenlove/prod/mongodb-uri` |
| Indexes | ✅ auth, catalog (incl. categories), carts | ✅ auth, catalog, carts (categories: not yet) |

Each environment's user can open only its own database, so a dev test can never change prod data.

### Settings stored in SSM

| Setting | Dev | Prod |
|---|---|---|
| `mongodb-uri` | ✅ | ✅ |
| `cloudinary-url` | ✅ | ⬜ **needed before uploading product images on prod** |
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
| Add Stripe fields (`customers.stripeCustomerId`, order payment info) | auth, checkout | ⬜ |
| New product fields: `searchTerms`, `shortDescription`, `label` (ingredients, allergens, statement), `storage`, `featuredRank`, `badges`; `netWeight` on each size | catalog | 🟡 on dev, not prod yet |
| `GET /categories`, plus staff `GET /admin/categories` and `PUT /admin/categories/{slug}` | catalog | 🟡 on dev, not prod yet |
| Product filters and sort: `q` (Atlas Search), `sort`, price range, delivery methods | catalog | ⬜ |
| `GET /products/suggest?q=` | catalog | ⬜ |
| Public availability for each product (ready dates, next delivery, how many are left) | catalog | ⬜ |
| Recently viewed: `GET /carts/{cartId}/views`, `GET /me/views` | carts | ⬜ |
| Saved addresses: `/me/addresses` | auth | ⬜ |
| **Checkout:** quote, pay (create the PaymentIntent), Stripe webhook, status | checkout (new) | ⬜ |
| **Stripe Tax** in the quote, recorded on payment, reversed on refund | checkout | ⬜ |
| **Promo codes:** collections, admin create/edit, `POST /promotions/check`, applied in the quote | checkout or a new stack | ⬜ |
| **Orders:** `/me/orders`, guest tracking link, staff status changes, refunds | orders (new) | ⬜ |
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

- [ ] Run the full Postman tests on dev. They need `POSTMAN_TEST_EMAIL` / `POSTMAN_TEST_PASSWORD` (a confirmed customer) and, for the admin and category tests, `POSTMAN_ADMIN_EMAIL` / `POSTMAN_ADMIN_PASSWORD` (a Staff or Admins user) in `.env`.
- [ ] Deploy the catalog changes to prod: `AWS_PROFILE=jmplutouser2 ./deploy.sh prod shared-infra catalog carts`, then `./scripts/with-db.sh prod -- npm --prefix catalog run indexes`.
- [ ] Create the categories (at least `body-care`) with `PUT /catalog/admin/categories/{slug}`.
- [ ] Add `/greenlove/prod/cloudinary-url` (needed before uploading product images on prod).
- [ ] Change the `oars_admin_user` Atlas password (it was exposed). Dev and prod no longer use that user.
- [ ] Optionally change the `greenlove_dev_user` and `greenlove_prod_user` passwords and save the new ones with `put-parameter --overwrite`.
- [ ] Create a Stripe account (test mode first), then store its keys in SSM, for example `/greenlove/{env}/stripe-secret-key` and `/greenlove/{env}/stripe-webhook-secret`.
- [ ] Turn on Stripe Tax and register for Texas sales tax. Confirm with an accountant how food, juice and cosmetics are taxed.
- [ ] Make the first prod admin: add your account to the `Admins` group (command in the README).
- [ ] Confirm SES is out of the sandbox in us-east-2 so emails can reach any customer.

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
