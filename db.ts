import "dotenv/config";
import {
  Binary,
  MongoClient,
  ObjectId,
  type Collection,
} from "mongodb";

export type SubscriptionPlan = "free" | "premium";
export type SubscriptionStatus = "active" | "cancelled" | "expired";
export type PaymentStatus = "paid" | "pending" | "failed";

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

export interface UserDocument {
  _id: EntityId;
  name: string;
  email: string;
  image?: string | null;
  role?: string;
  blocked?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface VendorProfileDocument {
  _id: ObjectId;
  userId: EntityId;
  restaurantName: string;
  description: string;
  image: string;
  area: string;
  city: string;
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus?: SubscriptionStatus;
  premiumSince?: Date | null;
  premiumExpiresAt?: Date | null;
  stripeCustomerId?: string | null;
  lastCheckoutSessionId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MenuStatus = "pending" | "approved" | "rejected" | "inactive";
export type OrderStatus = "pending" | "accepted" | "rejected" | "cancelled";

export interface MenuItemDocument {
  _id: ObjectId;
  vendorId: EntityId;
  vendorName: string;
  vendorImage?: string;
  vendorLocation?: string;
  name: string;
  category: string;
  description: string;
  price: number;
  location: string;
  image: string;
  status: MenuStatus;
  isActive: boolean;
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

export interface ImageDocument {
  _id: ObjectId;
  filename: string;
  contentType: string;
  size: number;
  data: Binary;
  uploadedBy: EntityId;
  createdAt: Date;
}

export interface TransactionDocument {
  _id: ObjectId;
  vendorId: EntityId;
  vendorName: string;
  plan: SubscriptionPlan;
  amount: number;
  currency?: string;
  paymentStatus: PaymentStatus;
  transactionDate: Date;
  createdAt: Date;
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
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
export const vendorProfilesCollection: Collection<VendorProfileDocument> =
  db.collection("vendorProfiles");
export const menuItemsCollection: Collection<MenuItemDocument> =
  db.collection("menuItems");
export const ordersCollection: Collection<OrderDocument> =
  db.collection("orders");
export const transactionsCollection: Collection<TransactionDocument> =
  db.collection("transactions");
export const imagesCollection: Collection<ImageDocument> =
  db.collection("images");

export async function connectToMongoDB() {
  await mongoClient.connect();
  console.log("Connected to MongoDB.");
  return mongoClient;
}
