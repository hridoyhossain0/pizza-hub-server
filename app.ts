import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";

import { requireAuth, requireRole } from "./jwt.ts";
import { ensureMongoConnection } from "./db.ts";
import { listMenuHandler } from "./menu.ts";
import { createOrderHandler, listOrdersHandler } from "./orders.ts";
import {
  cancelPremiumHandler,
  checkoutHandler,
  webhookHandler,
} from "./payments.ts";
import { tokenHandler } from "./tokens.ts";
import { uploadImageHandler } from "./uploads.ts";

/**
 * Express application shared by the local server (`index.ts`) and the Vercel
 * serverless entry point (`api/[...route].ts`).
 *
 * Keeping the app separate from `app.listen` means the same code runs locally
 * and as a serverless function without trying to bind a port in production.
 */
export const app = express();

const frontendUrl = (
  process.env.APP_URL?.trim() || "http://localhost:3000"
).replace(/\/$/, "");

const allowedOrigins = Array.from(
  new Set([frontendUrl, "http://localhost:3000", "http://127.0.0.1:3000"]),
);

/**
 * Vercel preview and production hosts change between deployments, so hosts of
 * this project are accepted in addition to the explicit allow-list. Requests
 * from any other origin get no CORS headers.
 */
function isAllowedOrigin(origin: string) {
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  return /^https:\/\/(pizza-hub(-server)?[a-z0-9-]*|pizza-[a-z0-9]+-hridoy15)\.vercel\.app$/.test(
    origin,
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "pizza-hub-server" });
});

app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

app.get("/api/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

// Keep health checks DB-free, but make every data route reconnect after a
// transient cold-start/network failure that closed the driver topology.
app.use(async (_request: Request, _response: Response, next: NextFunction) => {
  try {
    await ensureMongoConnection();
    next();
  } catch (error) {
    next(error);
  }
});

// Public menu API with advanced search and price sorting (Challenge 1).
app.get("/api/menu", listMenuHandler);

// Stripe needs the raw body for signature verification, so this route is
// registered before the JSON body parser.
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  webhookHandler,
);

// Base64 image uploads need a larger JSON limit than normal requests.
app.post(
  "/api/uploads",
  express.json({ limit: "8mb" }),
  uploadImageHandler,
);

app.use(express.json({ limit: "1mb" }));

// Public: exchange the Better Auth cookie for a short-lived JWT.
app.post("/api/auth/token", tokenHandler);

// JWT-protected order APIs. The role check runs after signature verification,
// so a forged token or a role changed to "customer" on the client is rejected.
app.get("/api/orders", requireAuth, listOrdersHandler);
app.post(
  "/api/orders",
  requireAuth,
  requireRole("customer"),
  createOrderHandler,
);

app.post(
  "/api/payments/checkout",
  requireAuth,
  requireRole("vendor"),
  checkoutHandler,
);

app.post(
  "/api/payments/cancel",
  requireAuth,
  requireRole("vendor"),
  cancelPremiumHandler,
);

app.use((_request: Request, response: Response) => {
  response.status(404).json({
    message: "The requested API route does not exist.",
  });
});

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    console.error("Unhandled API error", error);

    if (response.headersSent) {
      return;
    }

    response.status(500).json({
      message: "An unexpected server error occurred. Please try again.",
    });
  },
);

export default app;
