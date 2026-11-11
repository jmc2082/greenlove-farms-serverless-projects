# GreenLove Farms — Serverless Backend

AWS SAM (TypeScript, Node.js 24, arm64) in `us-east-2`, profile `jm_ubuntu_thinkpad_user` (on other machines, set `AWS_PROFILE`, for example `AWS_PROFILE=jmplutouser2 ./deploy.sh dev`).
Architecture and domain model: [docs/architecture.md](docs/architecture.md).
What's deployed, what's done and what's next: [docs/roadmap-and-status.md](docs/roadmap-and-status.md).
How the website calls each endpoint: [docs/frontend-api-guide.md](docs/frontend-api-guide.md).

## Stacks

| Folder | Deployed | Purpose |
|---|---|---|
| `domain-infra` | once | SES `greenlove-farms.com` identity + DKIM/MAIL FROM/DMARC, ACM cert, `api.` / `api-dev.` custom domains |
| `shared-infra` | per env | `@greenlove/shared` Lambda layer, SES configuration sets, SSM params |
| `auth` | per env | Cognito pool (Customers / Staff / Admins), signup/login, `/me`, admin roles — `.../auth` |
| `carts` | per env | Server-side carts (anonymous by `cartId` or `/me/cart`), merge on login, product views, watchlist — `.../carts` |
| `catalog` | per env | Products API + Staff/Admin product management + Cloudinary upload signing — `https://api[-dev].greenlove-farms.com/catalog` |

Shared helpers live only in `shared-infra/src/layers/shared/src` and are compiled into the layer as `@greenlove/shared`.
Stacks import from `@greenlove/shared` (resolved via `tsconfig` paths for typechecking, marked external in esbuild).

## First-time setup

```bash
# 1. Install deps (layer build + typechecking)
(cd shared-infra/src/layers/shared && npm install)
(cd auth && npm install)
(cd catalog && npm install)
(cd carts && npm install)

# 2. Secrets — SecureString params are created by hand, never in templates
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/dev/mongodb-uri --type SecureString --value '<dev connection string>'
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/prod/mongodb-uri --type SecureString --value '<prod connection string>'
# Cloudinary, in its own URL format (Dashboard → API Keys); same account for both envs, folders keep them apart
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/dev/cloudinary-url --type SecureString --value 'cloudinary://<api_key>:<api_secret>@<cloud_name>'
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/prod/cloudinary-url --type SecureString --value 'cloudinary://<api_key>:<api_secret>@<cloud_name>'
```

## Deploy order

```bash
(cd domain-infra && sam build && sam deploy)                          # once
(cd shared-infra && sam build && sam deploy --config-env dev)
(cd auth         && sam build && sam deploy --config-env dev)   # needs domain-infra's SES identity verified
(cd catalog      && sam build && sam deploy --config-env dev)   # reads Cognito ids from auth's SSM params
(cd carts        && sam build && sam deploy --config-env dev)
```

Prod: same commands with `--config-env prod`.

Or use the script, which runs the same steps in order (`domain-infra` only when named):

```bash
./deploy.sh dev                  # shared-infra, auth, catalog, carts
./deploy.sh prod catalog carts   # just the named stacks
./deploy.sh dev domain-infra
```

After the first deploy, create indexes:

```bash
for s in auth catalog carts; do ./scripts/with-db.sh dev -- npm --prefix $s run indexes; done
for s in auth catalog carts; do ./scripts/with-db.sh prod -- npm --prefix $s run indexes; done   # asks you to type "prod"
```

`scripts/with-db.sh dev|prod -- <command>` reads `/greenlove/<env>/mongodb-uri` from SSM and sets `MONGODB_URI` and `MONGODB_DB_NAME` (`greenlove_dev` / `greenlove_prod`) for that one command, so local tools hit the same database as the deployed environment. Prod always asks for confirmation (`CONFIRM_PROD=yes` skips it). Deployed functions never read `.env`.

Use a separate Atlas user per environment: `greenlove_dev_user` with readWrite on `greenlove_dev` only, and `greenlove_prod_user` with readWrite on `greenlove_prod` only. Then a dev connection string can't touch prod data, even by mistake.

First admin (sign up and confirm through the API first; after that, admins use `POST /auth/admin/users/role`):

```bash
POOL=$(aws ssm get-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/dev/cognito/user-pool-id --query Parameter.Value --output text)
aws cognito-idp admin-add-user-to-group --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --user-pool-id "$POOL" --username you@example.com --group-name Admins
```

Clients send the Cognito **ID token** as `Authorization: Bearer <idToken>` (it carries `email` and `cognito:groups`).

## Local

```bash
cd catalog
cp env.example.json env.json   # fill in MONGODB_URI
npm run typecheck
sam build && npm run local     # http://127.0.0.1:3000/products
```
