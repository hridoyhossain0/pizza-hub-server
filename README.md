# PizzaHub API Server

Express + TypeScript API for [PizzaHub](../pizza-hub). It handles JWT issuance
and verification, customer orders, Stripe Premium subscriptions, and menu/profile
image storage. Better Auth owns identity; this service never trusts a user id or
role supplied by the browser.

- **Runtime:** Node.js (local Express process) and Vercel serverless functions
- **Live API URL:** <https://pizza-hub-server-zeta.vercel.app>
- **Health check:** <https://pizza-hub-server-zeta.vercel.app/health>
- **Frontend URL:** <https://pizza-hub-rho-one.vercel.app>
- **Client repo:** <https://github.com/hridoyhossain0/pizza-hub>
- **Server repo:** <https://github.com/hridoyhossain0/pizza-hub-server>

## Endpoints

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | public | service metadata |
| `GET` | `/health` | public | health check |
| `GET` | `/api/menu` | public | approved menu with `q`, `category`, `location`, `sort`, `page`, `limit` |
| `POST` | `/api/auth/token` | Better Auth cookie | exchange session for a JWT |
| `GET` | `/api/orders` | JWT | signed-in customer's own orders |
| `POST` | `/api/orders` | JWT + `customer` | place an order |
| `POST` | `/api/payments/checkout` | JWT + `vendor` | create a Stripe Checkout Session |
| `POST` | `/api/payments/cancel` | JWT + `vendor` | stop Premium auto-continuation |
| `POST` | `/api/payments/webhook` | Stripe signature | activate Premium after payment |
| `POST` | `/api/uploads` | authenticated | upload an image to ImgBB |

### Menu search (Challenge 1)

`GET /api/menu?q=pizza&category=Classic%20Pizzas&location=Dhaka&sort=price_asc`

- `q` matches item name, description, category, location and restaurant name
  case-insensitively (regex-escaped).
- `sort` accepts `price_asc`, `price_desc` and `newest`; Premium items are
  featured first as a tie-breaker.
- `page`/`limit` paginate, and the response includes `total`, `pages` and
  `facets.categories` / `facets.locations`.
- Only `status: "approved"` items are ever returned.

## JWT flow

1. The user signs in through Better Auth in the Next.js app.
2. `POST /api/auth/token` validates the Better Auth session cookie and signs an
   HS256 JWT (`sub`, name, email, role) with `JWT_SECRET`, issuer
   `pizza-hub-server` and audience `pizza-hub-client`. Tokens expire after
   `JWT_TTL_SECONDS` (default 3600).
3. Clients send `Authorization: Bearer <token>`.
4. `requireAuth` verifies the signature, algorithm, expiry, issuer and audience,
   then re-reads the user from MongoDB. Blocked/deleted accounts are rejected and
   the role is always the current database role.
5. `requireRole(...)` returns `403` when the current role is not allowed.
6. Handlers re-check resource ownership and validate all input server-side.

`401` means missing, invalid or expired credentials; `403` means authenticated
but forbidden (wrong role or blocked account).

## Payments

Premium is a one-time Stripe Checkout payment for a 30-day period.

- `POST /api/payments/checkout` uses the **verified JWT** vendor id, so a vendor
  cannot create a session for another vendor.
- A `pending` transaction is stored when the session is created.
- `POST /api/payments/webhook` verifies the Stripe signature against the raw
  request body, then checks mode, payment status, amount, currency and metadata
  before marking the transaction paid and activating Premium.
- Stripe retries are idempotent: a session already marked paid never extends the
  subscription twice.
- The frontend success page only reads the stored transaction; it cannot activate
  a plan.

## Image uploads

`POST /api/uploads` accepts a base64 data URL (max 5 MB), validates the MIME
type and forwards it to ImgBB using `IMGBB_API_KEY`. The hosted ImgBB URL is
stored in the relevant MongoDB menu/profile document. Set `PUBLIC_API_URL` to
the deployed API origin for provider-independent frontend/API configuration.

## Environment variables

Create `.env` locally; it is git-ignored. Configure the same database,
Better Auth secret, and Google OAuth credentials in both services.

```bash
MONGODB_URL=mongodb+srv://...
BETTER_AUTH_SECRET=<same value as the frontend>
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<same Google OAuth client id as the frontend>
GOOGLE_CLIENT_SECRET=<same Google OAuth client secret as the frontend>
APP_URL=http://localhost:3000
PORT=7000
PUBLIC_API_URL=http://localhost:7000
JWT_SECRET=<at least 16 random characters>
JWT_TTL_SECONDS=3600
IMGBB_API_KEY=<ImgBB API key>
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=bdt
STRIPE_UNIT_AMOUNT=49900
```

`PORT`, `PUBLIC_API_URL`, `JWT_TTL_SECONDS`, `STRIPE_CURRENCY`, and
`STRIPE_UNIT_AMOUNT` have defaults. `APP_URL` must be the exact deployed
frontend origin for CORS and Checkout redirects. `PUBLIC_API_URL` must be the
public API origin so uploaded images keep working after deployment. Never commit
the actual values.

## Running locally

```bash
npm install
npm run dev
```

The API listens on <http://localhost:7000> and connects to the same MongoDB
database as the Next.js app.

For Stripe webhooks during development:

```bash
stripe listen --forward-to localhost:7000/api/payments/webhook
```

## Production deployment

1. Create the Atlas database and configure network access for Vercel. Set the
   same `MONGODB_URL` for the frontend and API.
2. Deploy this folder to Vercel. `vercel.json` rewrites `/api/*`, `/health` and
   `/` to the exported Express app in `api/[...route].ts`, so no long-running
   port is required. `local-server.ts` (used by `npm run dev`/`npm start`) is
   never invoked in production.
3. Set `APP_URL` and `BETTER_AUTH_URL` to the Vercel frontend origin and
   `PUBLIC_API_URL` to this API's public origin. Do not set `PORT` on Vercel.
4. Add the Google OAuth redirect URI
   `https://pizza-hub-rho-one.vercel.app/api/auth/callback/google` in Google
   Cloud and set the same OAuth client credentials in both deployments.
5. Register `https://pizza-hub-server-zeta.vercel.app/api/payments/webhook` in
   Stripe for `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `payment_intent.payment_failed`, `customer.subscription.updated`,
   `customer.subscription.deleted` and `invoice.payment_failed`.
   Store Stripe's signing secret as `STRIPE_WEBHOOK_SECRET`; do not expose it to
   the frontend.
6. Verify `/health`, auth redirects, API CORS from the deployed site, direct
   reloads of Next.js routes, image URLs, and Stripe test-mode subscription
   activation before switching to live payment keys.

## Project structure

```text
app.ts             Express app: CORS, routes, 404 and error handlers
local-server.ts    local entry point (connect + listen); not used on Vercel
api/index.ts       serverless entry for /api
api/[...route].ts  serverless catch-all for /api/*
vercel.json        serverless rewrites and function limits
auth.ts            Better Auth instance (same database/secret as the frontend)
jwt.ts             JWT signing, requireAuth, requireRole
tokens.ts          session-cookie → JWT endpoint
menu.ts            public search/sort API (Challenge 1)
orders.ts          JWT-protected order create/list handlers
payments.ts        Stripe Checkout, webhook verification, Premium activation
uploads.ts         ImgBB upload handler
db.ts              MongoDB client, collections and document types
```

## Database collections

The app uses exactly four business collections (plus Better Auth's session
collections):

| Collection | Key fields |
| --- | --- |
| `users` (Better Auth `user`) | `role`, `isBlocked`, `businessName`, `businessDescription`, `businessArea`, `businessCity`, `businessImage`, `subscriptionPlan`, `subscriptionExpiresAt` |
| `menuItems` | `vendorId`, `itemName`, `category`, `images[]`, `status`, `premium` |
| `orders` | `customerId`, `vendorId`, `itemId`, `status`, `deliveryDate` |
| `transactions` | `vendorId`, `stripeSessionId`, `stripeSubscriptionId`, `status`, `amount` |

## Security notes

- Secrets stay on the server; no Stripe or database key is exposed to the browser.
- CORS is restricted to the configured frontend origins.
- Stripe webhooks are verified with the raw body before any database write.
- Only the webhook can activate Premium.
- All order, payment and upload routes reject unauthenticated requests.
- The frontend obtains short-lived API tokens from the Better Auth session; the
  Express API remains the owner of the order, upload, and payment endpoints.
