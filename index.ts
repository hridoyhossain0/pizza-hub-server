import express, { type Request, type Response } from "express";
import cors from "cors";
import "dotenv/config";

import { connectToMongoDB } from "./db.ts";
import { checkoutHandler, webhookHandler } from "./payments.ts";
import { imageHandler, uploadImageHandler } from "./uploads.ts";

const app = express();

const frontendUrl = (
  process.env.APP_URL?.trim() || "http://localhost:3000"
).replace(/\/$/, "");

const allowedOrigins = Array.from(
  new Set([frontendUrl, "http://localhost:3000", "http://127.0.0.1:3000"]),
);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "pizza-hub-server" });
});

app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

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
app.get("/api/images/:id", imageHandler);

app.use(express.json({ limit: "1mb" }));

app.post("/api/payments/checkout", checkoutHandler);

const port = Number(process.env.PORT ?? 7000);

await connectToMongoDB();

app.listen(port, () => {
  console.log(`PizzaHub API listening on http://localhost:${port}`);
  console.log(`CORS origin: ${frontendUrl}`);
});
