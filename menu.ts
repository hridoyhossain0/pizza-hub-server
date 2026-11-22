import type { Request, Response } from "express";
import { type Filter } from "mongodb";

import { menuItemsCollection, type MenuItemDocument } from "./db.ts";

const SORT_OPTIONS = {
  price_asc: { price: 1 as const, premium: -1 as const },
  price_desc: { price: -1 as const, premium: -1 as const },
  newest: { premium: -1 as const, createdAt: -1 as const },
};

export type MenuSort = keyof typeof SORT_OPTIONS;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toPublicItem(item: MenuItemDocument) {
  const fallbackImage = "/placeholder-pizza.svg";
  const images =
    Array.isArray(item.images) && item.images.length > 0
      ? item.images
      : [fallbackImage];

  return {
    _id: item._id.toString(),
    vendorId: item.vendorId.toString(),
    vendorName: item.vendorName,
    vendorImage: item.vendorImage ?? null,
    vendorLocation: item.vendorLocation ?? null,
    itemName: item.itemName,
    category: item.category,
    description: item.description,
    price: item.price,
    location: item.location,
    images,
    status: item.status,
    premium: item.premium === true,
    createdAt: item.createdAt,
  };
}

/**
 * GET /api/menu
 *
 * Challenge 1 — advanced search and price sorting.
 *
 * Query parameters:
 *   q         free-text search across item name, category, description,
 *             restaurant name and location (case-insensitive, regex-escaped)
 *   category  exact category match
 *   location  case-insensitive match on the item location
 *   sort      price_asc | price_desc | newest (default newest)
 *   page      1-based page number (default 1)
 *   limit     page size, 1-50 (default 12)
 *
 * Only approved (publicly published) items are ever returned, so the endpoint
 * can back the public Browse Menu page.
 */
export function listMenuHandler(request: Request, response: Response) {
  void (async () => {
    try {
      const q = queryValue(request.query.q);
      const category = queryValue(request.query.category);
      const location = queryValue(request.query.location);
      const sortParam = queryValue(request.query.sort) as MenuSort;
      const sort = SORT_OPTIONS[sortParam] ? sortParam : "newest";

      const page = Math.max(1, Number(request.query.page) || 1);
      const limit = Math.min(
        50,
        Math.max(1, Number(request.query.limit) || 12),
      );

      const filter: Filter<MenuItemDocument> = { status: "approved" };

      if (q) {
        const regex = new RegExp(escapeRegex(q), "i");
        filter.$or = [
          { itemName: regex },
          { category: regex },
          { description: regex },
          { location: regex },
          { vendorName: regex },
        ];
      }

      if (category && category !== "all") {
        filter.category = category;
      }

      if (location && location !== "all") {
        filter.location = new RegExp(escapeRegex(location), "i");
      }

      const [items, total, categories, locations] = await Promise.all([
        menuItemsCollection
          .find(filter)
          .sort(SORT_OPTIONS[sort])
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        menuItemsCollection.countDocuments(filter),
        menuItemsCollection.distinct("category", { status: "approved" }),
        menuItemsCollection.distinct("location", { status: "approved" }),
      ]);

      response.setHeader("Cache-Control", "public, max-age=30");
      response.json({
        items: items.map(toPublicItem),
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        sort,
        filters: { q, category, location },
        facets: {
          categories: categories.sort(),
          locations: locations.sort(),
        },
      });
    } catch (error) {
      console.error("Could not list the public menu", error);
      response
        .status(500)
        .json({ message: "The menu could not be loaded. Please try again." });
    }
  })();
}
