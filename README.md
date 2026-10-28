# GreenLove Farms — Serverless Backend

AWS SAM (TypeScript, Node.js 24, arm64) in `us-east-2`, profile `jm_ubuntu_thinkpad_user`.
Architecture and domain model: [docs/architecture.md](docs/architecture.md).

## Stacks

| Folder | Deployed | Purpose |
|---|---|---|
| `domain-infra` | once | SES `greenlove-farms.com` identity + DKIM/MAIL FROM/DMARC, ACM cert, `api.` / `api-dev.` custom domains |
| `shared-infra` | per env | `@greenlove/shared` Lambda layer, SES configuration sets, SSM params |
| `catalog` | per env | Products API, served at `https://api[-dev].greenlove-farms.com/catalog` |

Shared helpers live only in `shared-infra/src/layers/shared/src` and are compiled into the layer as `@greenlove/shared`.
Stacks import from `@greenlove/shared` (resolved via `tsconfig` paths for typechecking, marked external in esbuild).

## First-time setup

```bash
# 1. Install deps (layer build + typechecking)
(cd shared-infra/src/layers/shared && npm install)
(cd catalog && npm install)

# 2. Secrets — SecureString params are created by hand, never in templates
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/dev/mongodb-uri --type SecureString --value '<dev connection string>'
aws ssm put-parameter --profile jm_ubuntu_thinkpad_user --region us-east-2 \
  --name /greenlove/prod/mongodb-uri --type SecureString --value '<prod connection string>'
```

## Deploy order

```bash
(cd domain-infra && sam build && sam deploy)                          # once
(cd shared-infra && sam build && sam deploy --config-env dev)
(cd catalog      && sam build && sam deploy --config-env dev)
```

Prod: same commands with `--config-env prod`.

After the first catalog deploy, create indexes:

```bash
cd catalog && MONGODB_URI='<conn>' MONGODB_DB_NAME=greenlove_dev npm run indexes
```

## Local

```bash
cd catalog
cp env.example.json env.json   # fill in MONGODB_URI
npm run typecheck
sam build && npm run local     # http://127.0.0.1:3000/products
```
