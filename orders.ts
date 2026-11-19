import type { Request, Response } from "express";
import { ObjectId } from "mongodb";

import {
  idFilter,
  menuItemsCollection,
  ordersCollection,
} from "./db.ts";

interface OrderBody {
  itemId?: unknown;
  quantity?: unknown;
  deliveryDate?: unknown;
  deliveryAddress?: unknown;
  message?: unknown;
}

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * POST /api/orders
 *
 * Runs behind `requireAuth` and `requireRole("customer")`, so the customer is
 * taken from the verified JWT — never from the request body. The vendor and the
 * item are resolved from the database, which prevents one restaurant from
 * receiving (or paying for) another restaurant's order.
 */
export async function createOrderHandler(request: Request, response: Response) {
  const auth = request.auth;

  if (!auth) {
    response.status(401).json({ message: "Please sign in to place an order." });
    return;
  }

  const body = (request.body ?? {}) as OrderBody;
  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";

  if (!ObjectId.isValid(itemId)) {
    response
      .status(400)
      .json({ message: "The selected menu item could not be found." });
    return;
  }

  const item = await menuItemsCollection.findOne({
    _id: new ObjectId(itemId),
    status: "approved",
    isActive: true,
  });

  if (!item) {
    response.status(404).json({
      message: "This menu item is no longer available for ordering.",
    });
    return;
  }

  if (item.vendorId.toString() === auth.id) {
    response
      .status(403)
      .json({ message: "You cannot order your own menu items." });
    return;
  }

  const quantity = Number(body.quantity ?? 1);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    response.status(400).json({
      message: "Quantity must be a whole number between 1 and 10.",
    });
    return;
  }

  const deliveryDate =
    typeof body.deliveryDate === "string" ? body.deliveryDate.trim() : "";
  const deliveryAddress =
    typeof body.deliveryAddress === "string"
      ? body.deliveryAddress.trim()
      : "";
  const message =
    typeof body.message === "string" ? body.message.trim() : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
    response
      .status(400)
      .json({ message: "Please choose a valid delivery date." });
    return;
  }

  if (deliveryDate < localToday()) {
    response
      .status(400)
      .json({ message: "The delivery date cannot be in the past." });
    return;
  }

  if (deliveryAddress.length < 5 || deliveryAddress.length > 500) {
    response.status(400).json({
      message: "Delivery address is required (5-500 characters).",
    });
    return;
  }

  if (message.length > 1000) {
    response.status(400).json({
      message: "Additional message must be 1000 characters or fewer.",
    });
    return;
  }

  try {
    const duplicate = await ordersCollection.findOne({
      customerId: idFilter(auth.id),
      itemId,
      deliveryDate,
      status: { $in: ["pending", "accepted"] },
    });

    if (duplicate) {
      response.status(409).json({
        message:
          "You already have an active order for this item on the selected delivery date.",
      });
      return;
    }

    const now = new Date();

    await ordersCollection.insertOne({
      _id: new ObjectId(),
      customerId: auth.id,
      customerName: auth.name,
      customerEmail: auth.email,
      vendorId: item.vendorId.toString(),
      vendorName: item.vendorName,
      itemId: item._id.toString(),
      itemName: item.name,
      itemImage: item.image,
      unitPrice: item.price,
      quantity,
      deliveryDate,
      deliveryAddress,
      message,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    response.status(201).json({
      message:
        "Your order has been placed successfully. The restaurant will review it shortly.",
    });
  } catch (error) {
    console.error("Could not place order", error);
    response
      .status(500)
      .json({ message: "The order could not be saved. Please try again." });
  }
}

/** GET /api/orders — the signed-in customer's own orders, newest first. */
export async function listOrdersHandler(request: Request, response: Response) {
  const auth = request.auth;

  if (!auth) {
    response
      .status(401)
      .json({ message: "Please sign in to view your orders." });
    return;
  }

  try {
    const orders = await ordersCollection
      .find({ customerId: idFilter(auth.id) })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    response.json({
      orders: orders.map((order) => ({
        ...order,
        _id: order._id.toString(),
        customerId: order.customerId.toString(),
        vendorId: order.vendorId.toString(),
      })),
    });
  } catch (error) {
    console.error("Could not load orders", error);
    response
      .status(500)
      .json({ message: "Your orders could not be loaded." });
  }
}
