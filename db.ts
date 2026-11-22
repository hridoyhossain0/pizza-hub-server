import "dotenv/config";
import { MongoClient, ObjectId, type Collection } from "mongodb";

export type SubscriptionPlan = "free" | "premium";
export type SubscriptionStatus = "active" | "cancelled" | "expired";
export type PaymentStatus = "paid" | "pending" | "failed";
export type MenuStatus = "pending" | "approved" | "rejected" | "inactive";
export type OrderStatus = "pending" | "accepted" | "rejected" | "cancelled";

/**
 * Better Auth stores `_id` and session `userId` values as `ObjectId`, while the
 * app writes foreign keys as strings. Every lookup accepts both forms.
 */
export type EntityId = string | ObjectId;

export function idFilter(value: string): { $in: EntityId[] } {
  return {
    $in: ObjectId.isValid(value) ? [value, new ObjectId(value)] : [value],
  };
}

/**
 * `users` is the Better Auth collection. Business fields for vendors live on
 * the same document (there is no separate vendor profile collection), which
 * keeps the schema to the four business collections required by the brief.
 */
export interface UserDocument {
  _id: EntityId;
  name: string;
  email: string;
  image?: string | null;
  role?: string;
  isBlocked?: boolean;
  /** Vendor only. */
  businessName?: string;
  businessDescription?: string;
  businessImage?: string;
  businessArea?: string;
  businessCity?: string;
  subscriptionPlan?: SubscriptionPlan;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionExpiresAt?: Date | null;
  premiumSince?: Date | null;
  stripeCustomerId?: string | null;
  lastCheckoutSessionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MenuItemDocument {
  _id: ObjectId;
  vendorId: EntityId;
  vendorName: string;
  vendorImage?: string;
  vendorLocation?: string;
  itemName: string;
  category: string;
  description: string;
  price: number;
  location: string;
  images: string[];
  status: MenuStatus;
  premium: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDocument {
  _id: ObjectId;
  customerId: EntityId;
  customerName: string;
  customerEmail: string;
  vendorId: EntityId;
  vendorName: string;
  itemId: string;
  itemName: string;
  itemImage: string;
  unitPrice: number;
  quantity: number;
  deliveryDate: string;
  deliveryAddress: string;
  message: string;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionDocument {
  _id: ObjectId;
  vendorId: EntityId;
  vendorName: string;
  plan: SubscriptionPlan;
  amount: number;
  currency?: string;
  stripeSessionId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePaymentIntentId?: string | null;
  status: PaymentStatus;
  transactionDate: Date;
  createdAt: Date;
}

const uri = process.env.MONGODB_URL;

if (!uri) {
  throw new Error("MONGODB_URL is not configured.");
}

/**
 * The URI has no database name, so `db()` resolves to MongoDB's default
 * database ("test") — the same database Better Auth and the frontend use.
 */
export const mongoClient = new MongoClient(uri);
export const db = mongoClient.db();

export const usersCollection: Collection<UserDocument> =
  db.collection("user");
export const menuItemsCollection: Collection<MenuItemDocument> =
  db.collection("menuItems");
export const ordersCollection: Collection<OrderDocument> =
  db.collection("orders");
export const transactionsCollection: Collection<TransactionDocument> =
  db.collection("transactions");

export async function connectToMongoDB() {
  await mongoClient.connect();
  console.log("Connected to MongoDB.");
  return mongoClient;
}
