import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

import {
  idFilter,
  menuItemsCollection,
  transactionsCollection,
  vendorProfilesCollection,
  type VendorProfileDocument,
} from "./db.ts";

const PREMIUM_PERIOD_DAYS = 30;

interface PremiumPriceConfig {
  currency: string;
  unitAmount: number;
}

let stripeClient: Stripe | null = null;
let indexPromise: Promise<unknown> | null = null;

/** Server-only Stripe client. Returns null while keys are not configured. */
export function getStripe(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!secretKey) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

export function getPremiumPriceConfig(): PremiumPriceConfig {
  const currency = (process.env.STRIPE_CURRENCY?.trim() || "bdt").toLowerCase();
  const unitAmount = Number(process.env.STRIPE_UNIT_AMOUNT?.trim() || 49900);

  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error(
      "STRIPE_CURRENCY must be a three-letter ISO currency code such as bdt or usd.",
    );
  }

  if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
    throw new Error(
      "STRIPE_UNIT_AMOUNT must be a positive integer in the currency's minor unit.",
    );
  }

  return { currency, unitAmount };
}

/** Idempotent indexes. The unique session index makes retries safe. */
export function ensurePaymentIndexes() {
  if (!indexPromise) {
    indexPromise = Promise.all([
      transactionsCollection.createIndex(
        { stripeSessionId: 1 },
        {
          name: "stripe_session_unique",
          unique: true,
          partialFilterExpression: {
            stripeSessionId: { $type: "string" },
          },
        },
      ),
      vendorProfilesCollection.createIndex({ premiumExpiresAt: 1 }),
    ]).catch((error) => {
      indexPromise = null;
      throw error;
    });
  }

  return indexPromise;
}

function addPremiumPeriod(from: Date, days = PREMIUM_PERIOD_DAYS) {
  const end = new Date(from);
  end.setDate(end.getDate() + days);
  return end;
}

function isExpired(profile: VendorProfileDocument, now: Date) {
  return Boolean(
    profile.premiumExpiresAt &&
      profile.premiumExpiresAt.getTime() <= now.getTime(),
  );
}

/** Downgrades a vendor whose paid period has ended. */
export async function expireVendorSubscription(
  userId: string,
  now = new Date(),
): Promise<VendorProfileDocument | null> {
  const profile = await vendorProfilesCollection.findOne({
    userId: idFilter(userId),
  });

  if (!profile) {
    return null;
  }

  if (profile.subscriptionPlan !== "premium" || !isExpired(profile, now)) {
    return profile;
  }

  await vendorProfilesCollection.updateOne(
    { userId: idFilter(userId), subscriptionPlan: "premium" },
    {
      $set: {
        subscriptionPlan: "free",
        subscriptionStatus: "expired",
        premiumExpiresAt: null,
        updatedAt: now,
      },
    },
  );

  await menuItemsCollection.updateMany(
    { vendorId: idFilter(userId) },
    { $set: { premium: false, updatedAt: now } },
  );

  return {
    ...profile,
    subscriptionPlan: "free",
    subscriptionStatus: "expired",
    premiumExpiresAt: null,
    updatedAt: now,
  };
}

/** Activates or extends Premium. Only the verified webhook may call this. */
async function activateVendorPremium({
  vendorId,
  checkoutSessionId,
  stripeCustomerId,
  now = new Date(),
}: {
  vendorId: string;
  checkoutSessionId: string;
  stripeCustomerId?: string | null;
  now?: Date;
}) {
  const profile = await vendorProfilesCollection.findOne({
    userId: idFilter(vendorId),
  });

  if (!profile) {
    return null;
  }

  const base =
    profile.subscriptionPlan === "premium" &&
    profile.premiumExpiresAt &&
    profile.premiumExpiresAt.getTime() > now.getTime()
      ? profile.premiumExpiresAt
      : now;

  const premiumExpiresAt = addPremiumPeriod(base);

  await vendorProfilesCollection.updateOne(
    { userId: idFilter(vendorId) },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionStatus: "active",
        premiumSince: profile.premiumSince ?? now,
        premiumExpiresAt,
        stripeCustomerId:
          stripeCustomerId ?? profile.stripeCustomerId ?? null,
        lastCheckoutSessionId: checkoutSessionId,
        updatedAt: now,
      },
    },
  );

  await menuItemsCollection.updateMany(
    { vendorId: idFilter(vendorId) },
    { $set: { premium: true, updatedAt: now } },
  );

  return profile;
}

function paymentIntentId(session: Stripe.Checkout.Session) {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  return session.payment_intent?.id ?? null;
}

function customerId(session: Stripe.Checkout.Session) {
  if (typeof session.customer === "string") {
    return session.customer;
  }

  return session.customer?.id ?? null;
}

/**
 * POST /api/payments/checkout
 *
 * Runs behind `requireAuth` and `requireRole("vendor")`. The vendor id always
 * comes from the verified JWT — never from the request body — so one vendor
 * cannot pay for, or upgrade, another vendor.
 */
export async function checkoutHandler(request: Request, response: Response) {
  try {
    const auth = request.auth;

    if (!auth) {
      response
        .status(401)
        .json({ message: "Please sign in to upgrade your subscription." });
      return;
    }

    if (auth.role !== "vendor") {
      response.status(403).json({
        message: "Only vendor accounts can purchase a Premium subscription.",
      });
      return;
    }

    // Lazy expiry lets an overdue vendor renew instead of being treated as
    // already Premium.
    const profile = await expireVendorSubscription(auth.id);

    if (!profile) {
      response.status(400).json({
        message:
          "Create your restaurant profile before upgrading your subscription.",
      });
      return;
    }

    if (profile.subscriptionPlan === "premium") {
      response
        .status(409)
        .json({ message: "Your subscription is already Premium." });
      return;
    }

    const stripe = getStripe();

    if (!stripe) {
      response.status(503).json({
        message:
          "Payments are not configured yet. Add STRIPE_SECRET_KEY to the API server and restart it.",
      });
      return;
    }

    let price: PremiumPriceConfig;

    try {
      price = getPremiumPriceConfig();
    } catch (error) {
      response.status(500).json({
        message:
          error instanceof Error
            ? error.message
            : "The payment amount is not configured correctly.",
      });
      return;
    }

    const appUrl = (
      process.env.APP_URL?.trim() || "http://localhost:3000"
    ).replace(/\/$/, "");

    await ensurePaymentIndexes().catch((error) => {
      console.error("Could not create payment indexes", error);
    });

    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: auth.id,
      customer_email: auth.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: price.currency,
            unit_amount: price.unitAmount,
            product_data: {
              name: "PizzaHub Premium",
              description:
                "Unlimited active menu items, Premium badge and featured placement for 30 days.",
            },
          },
        },
      ],
      metadata: {
        vendorId: auth.id,
        plan: "premium",
      },
      payment_intent_data: {
        metadata: {
          vendorId: auth.id,
          plan: "premium",
        },
      },
      success_url: `${appUrl}/dashboard/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/dashboard/vendor/subscription/cancel`,
    });

    if (!checkout.url) {
      response.status(502).json({
        message: "Stripe did not return a checkout URL. Please try again.",
      });
      return;
    }

    const now = new Date();

    try {
      // A pending record lets the frontend and admins see checkout attempts.
      // Only the verified webhook may mark it paid.
      await transactionsCollection.insertOne({
        _id: new ObjectId(),
        vendorId: auth.id,
        vendorName: profile.restaurantName,
        plan: "premium",
        amount: price.unitAmount / 100,
        currency: price.currency,
        paymentStatus: "pending",
        transactionDate: now,
        createdAt: now,
        stripeSessionId: checkout.id,
        stripePaymentIntentId: null,
      });
    } catch (error) {
      console.error("Could not save pending transaction", error);
    }

    response.setHeader("Cache-Control", "no-store");
    response.json({ url: checkout.url });
  } catch (error) {
    console.error("Stripe checkout session failed", error);
    response.status(502).json({
      message:
        error instanceof Error
          ? error.message
          : "Unable to start checkout. Please try again.",
    });
  }
}

async function markSessionFailed(sessionId: string) {
  await transactionsCollection.updateOne(
    { stripeSessionId: sessionId, paymentStatus: "pending" },
    {
      $set: {
        paymentStatus: "failed",
        transactionDate: new Date(),
      },
    },
  );
}

/**
 * The only place where Premium becomes active.
 *
 * Signature verification plus amount, currency, mode and metadata checks
 * guarantee that only a genuinely paid Stripe Checkout upgrades a vendor.
 */
async function handleCheckoutPaid(session: Stripe.Checkout.Session) {
  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return;
  }

  const vendorId =
    typeof session.metadata?.vendorId === "string"
      ? session.metadata.vendorId
      : "";

  if (!vendorId || session.metadata?.plan !== "premium") {
    console.error("Checkout session is missing PizzaHub metadata", session.id);
    return;
  }

  if (
    session.client_reference_id &&
    session.client_reference_id !== vendorId
  ) {
    console.error("Checkout session vendor mismatch", session.id);
    return;
  }

  let price: PremiumPriceConfig;

  try {
    price = getPremiumPriceConfig();
  } catch (error) {
    console.error("Invalid Premium price configuration", error);
    return;
  }

  if (
    session.amount_total !== price.unitAmount ||
    (session.currency ?? "").toLowerCase() !== price.currency
  ) {
    console.error("Checkout session amount mismatch", {
      sessionId: session.id,
      amountTotal: session.amount_total,
      currency: session.currency,
    });
    return;
  }

  // Stripe retries events. If this session is already paid, do not extend the
  // vendor's period a second time.
  const existing = await transactionsCollection.findOne({
    stripeSessionId: session.id,
  });

  if (existing?.paymentStatus === "paid") {
    return;
  }

  const profile = await vendorProfilesCollection.findOne({
    userId: idFilter(vendorId),
  });

  if (!profile) {
    console.error("Paid checkout for a missing vendor profile", vendorId);
    return;
  }

  const now = new Date();

  await transactionsCollection.updateOne(
    { stripeSessionId: session.id },
    {
      $set: {
        vendorId,
        vendorName: profile.restaurantName,
        plan: "premium",
        amount: (session.amount_total ?? 0) / 100,
        currency: (session.currency ?? price.currency).toLowerCase(),
        paymentStatus: "paid",
        transactionDate: new Date(session.created * 1000),
        stripePaymentIntentId: paymentIntentId(session),
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
        stripeSessionId: session.id,
      },
    },
    { upsert: true },
  );

  await activateVendorPremium({
    vendorId,
    checkoutSessionId: session.id,
    stripeCustomerId: customerId(session),
    now,
  });
}

/**
 * POST /api/payments/webhook
 *
 * Stripe calls this directly. It must receive the raw body for the signature
 * check, so the raw parser is mounted for this route before `express.json()`.
 */
export async function webhookHandler(request: Request, response: Response) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!stripe) {
    console.error("Stripe webhook received before Stripe was configured.");
    response.status(503).json({ message: "Stripe is not configured." });
    return;
  }

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured.");
    response.status(503).json({ message: "Stripe webhook is not configured." });
    return;
  }

  const signature = request.headers["stripe-signature"];

  if (typeof signature !== "string") {
    response.status(400).json({ message: "Missing Stripe signature." });
    return;
  }

  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ message: "Invalid Stripe payload." });
    return;
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error("Invalid Stripe webhook signature", error);
    response.status(400).json({ message: "Invalid Stripe signature." });
    return;
  }

  await ensurePaymentIndexes().catch((error) => {
    console.error("Could not create payment indexes", error);
  });

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        await handleCheckoutPaid(
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await markSessionFailed(session.id);
        break;
      }
      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;

        // Match the exact intent. Never fail every pending checkout for the
        // vendor — another session may be in progress.
        await transactionsCollection.updateOne(
          {
            stripePaymentIntentId: intent.id,
            paymentStatus: "pending",
          },
          {
            $set: {
              paymentStatus: "failed",
              transactionDate: new Date(),
            },
          },
        );
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    response.status(500).json({ message: "Webhook processing failed." });
    return;
  }

  response.json({ received: true });
}
