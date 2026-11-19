import type { Request, Response } from "express";

import { auth, normalizeUserRole, toRequestHeaders } from "./auth.ts";
import { signAuthToken, tokenTtlSeconds } from "./jwt.ts";

/**
 * POST /api/auth/token
 *
 * Exchanges the Better Auth session cookie for a short-lived JWT that the
 * browser can send to the JWT-protected Express APIs. The cookie is still the
 * only credential accepted here, so a client can never mint a token for a
 * different user.
 */
export async function tokenHandler(request: Request, response: Response) {
  try {
    const session = await auth.api.getSession({
      headers: toRequestHeaders(request),
    });

    if (!session?.user) {
      response
        .status(401)
        .json({ message: "Please sign in to request an access token." });
      return;
    }

    const user = session.user as typeof session.user & {
      role?: unknown;
      blocked?: unknown;
    };

    if (user.blocked === true) {
      response.status(403).json({
        message: "Blocked accounts cannot request an access token.",
      });
      return;
    }

    const token = signAuthToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: normalizeUserRole(user.role),
    });

    response.setHeader("Cache-Control", "no-store");
    response.json({
      token,
      tokenType: "Bearer",
      expiresIn: tokenTtlSeconds(),
    });
  } catch (error) {
    console.error("Could not issue an access token", error);
    response
      .status(500)
      .json({ message: "The access token could not be issued." });
  }
}
