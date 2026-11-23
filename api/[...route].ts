import app from "../app.ts";

/**
 * Vercel serverless entry point.
 *
 * `api/[...route].ts` is a catch-all, so every `/api/*` request (including the
 * Stripe webhook and the image upload route) is handled by the same Express
 * app that runs locally. Exporting the app lets Vercel invoke it as a
 * function instead of trying to bind a port.
 */
export default app;
