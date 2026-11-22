import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import type { Request } from "express";

import { db, mongoClient } from "./db.ts";

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

const frontendUrl = (
  process.env.BETTER_AUTH_URL?.trim() ||
  process.env.APP_URL?.trim() ||
  "http://localhost:3000"
).replace(/\/$/, "");

const trustedOrigins = Array.from(
  new Set([
    frontendUrl,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]),
);

/**
 * Same auth instance as the Next.js app (same database and secret), so the
 * Express API can validate the session cookie set by Better Auth.
 */
export const auth = betterAuth({
  baseURL: frontendUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(db, {
    client: mongoClient,
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders:
    googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : {},
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "customer",
        input: false,
      },
      isBlocked: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      subscriptionPlan: {
        type: "string",
        required: false,
        defaultValue: "free",
        input: false,
      },
      subscriptionExpiresAt: {
        type: "date",
        required: false,
        input: false,
      },
      businessName: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  trustedOrigins,
});

/** Converts Express request headers into the `Headers` Better Auth expects. */
export function toRequestHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

export type UserRole = "customer" | "vendor" | "admin";

export function normalizeUserRole(value: unknown): UserRole {
  return value === "admin" || value === "vendor" || value === "customer"
    ? value
    : "customer";
}
