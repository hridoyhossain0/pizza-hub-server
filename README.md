# PizzaHub API Server

Express + TypeScript API for [PizzaHub](../pizza-hub). It handles JWT issuance
and verification, customer orders, Stripe Premium subscriptions, and menu/profile
image storage. Better Auth owns identity; this service never trusts a user id or
role supplied by the browser.

- **Frontend repository:** _add the GitHub URL here_
- **Live API URL:** _add the deployed API URL here_
- **Live site:** _add the deployed frontend URL here_

## Endpoints

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | public | service metadata |
| `GET` | `/health` | public | health check |
| `POST` | `/api/auth/token` | Better Auth cookie | exchange session for a JWT |
| `GET` | `/api/orders` | JWT | signed-in customer's own orders |
| `POST` | `/api/orders` | JWT + `customer` | place an order |
| `POST` | `/api/payments/checkout` | JWT + `vendor` | create a Stripe Checkout Session |
| `POST` | `/api/payments/webhook` | Stripe signature | activate Premium after payment |
| `POST` | `/api/uploads` | authenticated | store an image in MongoDB |
| `GET` | `/api/images/:id` | public | serve a stored image |

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

`POST /api/uploads` accepts a base64 data URL (max 8 MB by default), validates the
MIME type and stores the bytes in the `images` collection. `GET /api/images/:id`
streams them back with long-lived cache headers. Set `PUBLIC_API_URL` to the
deployed API origin so stored URLs resolve in production.

## Environment variables

Create `.env` locally; it is git-ignored.

```bash
MONGODB_URL=mongodb+srv://...
BETTER_AUTH_SECRET=<same value as the frontend>
BETTER_AUTH_URL=http://localhost:3000
APP_URL=http://localhost:3000
PORT=7000
PUBLIC_API_URL=http://localhost:7000
JWT_SECRET=<at least 16 random characters>
JWT_TTL_SECONDS=3600

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=bdt
STRIPE_UNIT_AMOUNT=49900
```

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

## Project structure

```text
index.ts      Express app, CORS, route registration
auth.ts       Better Auth instance (same database/secret as the frontend)
jwt.ts        JWT signing, requireAuth, requireRole
tokens.ts     session-cookie → JWT endpoint
orders.ts     JWT-protected order create/list handlers
payments.ts   Stripe Checkout, webhook verification, Premium activation
uploads.ts    MongoDB image upload/serve handlers
db.ts         MongoDB client, collections and document types
```

## Security notes

- Secrets stay on the server; no Stripe or database key is exposed to the browser.
- CORS is restricted to the configured frontend origins.
- Stripe webhooks are verified with the raw body before any database write.
- Only the webhook can activate Premium.
- All order, payment and upload routes reject unauthenticated requests.
