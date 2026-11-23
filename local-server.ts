import "dotenv/config";

import { app } from "./app.ts";
import { connectToMongoDB } from "./db.ts";

/**
 * Local development entry point. On Vercel the app is exported from
 * `api/[...route].ts` instead, because serverless functions must not bind a
 * port.
 */
const port = Number(process.env.PORT ?? 7000);

await connectToMongoDB();

app.listen(port, () => {
  console.log(`PizzaHub API listening on http://localhost:${port}`);
  console.log(
    `CORS origin: ${
      process.env.APP_URL?.trim() || "http://localhost:3000"
    }`,
  );
});
