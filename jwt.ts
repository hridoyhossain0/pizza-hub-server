import jwt, { type JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

import { normalizeUserRole, type UserRole } from "./auth.ts";
import { idFilter, usersCollection } from "./db.ts";

const TOKEN_ISSUER = "pizza-hub-server";
const TOKEN_AUDIENCE = "pizza-hub-client";

export interface AuthContext {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface AuthTokenPayload extends JwtPayload {
  name?: string;
  email?: string;
  role?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret || secret.length < 16) {
    throw new Error(
      "JWT_SECRET must be configured with at least 16 characters.",
    );
  }

  return secret;
}

export function tokenTtlSeconds(): number {
  const value = Number(process.env.JWT_TTL_SECONDS?.trim() || 3600);

  if (!Number.isInteger(value) || value < 60) {
    return 3600;
  }

  return value;
}

/** Signs a short-lived access token for an authenticated platform user. */
export function signAuthToken(user: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}): string {
  return jwt.sign(
    {
      name: user.name,
      email: user.email,
      role: user.role,
    },
    jwtSecret(),
    {
      algorithm: "HS256",
      subject: user.id,
      expiresIn: tokenTtlSeconds(),
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    },
  );
}

/**
 * Verifies `Authorization: Bearer <token>`.
 *
 * A valid signature is not enough: the account is re-read so a blocked or
 * deleted user cannot keep using a token that has not expired yet, and the
 * role always reflects the current database value.
 */
export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const header = request.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";

  if (!token) {
    response
      .status(401)
      .json({ message: "A valid access token is required for this request." });
    return;
  }

  let payload: AuthTokenPayload;

  try {
    payload = jwt.verify(token, jwtSecret(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as AuthTokenPayload;
  } catch (error) {
    const expired =
      error instanceof jwt.TokenExpiredError ? "expired" : "invalid";

    response.status(401).json({
      message: `Your access token is ${expired}. Please sign in again.`,
    });
    return;
  }

  if (typeof payload.sub !== "string" || !payload.sub) {
    response.status(401).json({ message: "The access token is invalid." });
    return;
  }

  try {
    const user = await usersCollection.findOne(
      { _id: idFilter(payload.sub) },
      { projection: { name: 1, email: 1, role: 1, isBlocked: 1 } },
    );

    if (!user) {
      response
        .status(401)
        .json({ message: "The account for this token no longer exists." });
      return;
    }

    if (user.isBlocked === true) {
      response.status(403).json({
        message:
          "Your account has been blocked by an administrator and cannot use this feature.",
      });
      return;
    }

    request.auth = {
      id: payload.sub,
      name: user.name,
      email: user.email,
      role: normalizeUserRole(user.role),
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** Role-based authorization. Always runs after `requireAuth`. */
export function requireRole(...roles: UserRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) {
      response.status(401).json({ message: "Please sign in to continue." });
      return;
    }

    if (!roles.includes(request.auth.role)) {
      response.status(403).json({
        message: "You do not have permission to perform this action.",
      });
      return;
    }

    next();
  };
}
