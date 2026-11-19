import type { Request, Response } from "express";
import { ObjectId, Binary } from "mongodb";

import { auth, toRequestHeaders } from "./auth.ts";
import { imagesCollection } from "./db.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function publicApiUrl() {
  return (
    process.env.PUBLIC_API_URL?.trim() ||
    `http://localhost:${process.env.PORT ?? 7000}`
  ).replace(/\/$/, "");
}

function safeFilename(value: unknown) {
  if (typeof value !== "string") {
    return "image";
  }

  return (
    value
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/\s+/g, "-")
      .slice(0, 120) || "image"
  );
}

/**
 * POST /api/uploads
 *
 * Authenticated image upload used by menu items and profile pictures. The
 * image is stored in MongoDB (max 5MB) and served by GET /api/images/:id, so
 * the app no longer depends on an external image host or API key.
 */
export async function uploadImageHandler(
  request: Request,
  response: Response,
) {
  try {
    const session = await auth.api.getSession({
      headers: toRequestHeaders(request),
    });

    if (!session?.user) {
      response.status(401).json({ message: "Please sign in to upload an image." });
      return;
    }

    if ((session.user as { blocked?: unknown }).blocked === true) {
      response
        .status(403)
        .json({ message: "Blocked accounts cannot upload images." });
      return;
    }

    const body = request.body as {
      filename?: unknown;
      contentType?: unknown;
      data?: unknown;
    } | null;

    const contentType =
      typeof body?.contentType === "string" ? body.contentType : "";
    const encoded = typeof body?.data === "string" ? body.data : "";

    if (!encoded) {
      response.status(400).json({ message: "No image data was received." });
      return;
    }

    if (!ALLOWED_TYPES.has(contentType)) {
      response.status(415).json({
        message: "Only JPG, PNG, WebP or GIF images are allowed.",
      });
      return;
    }

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      response.status(400).json({ message: "The image data is invalid." });
      return;
    }

    const buffer = Buffer.from(encoded, "base64");

    if (buffer.length === 0) {
      response.status(400).json({ message: "The image file is empty." });
      return;
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      response
        .status(413)
        .json({ message: "Image size must be 5MB or smaller." });
      return;
    }

    const document = {
      _id: new ObjectId(),
      filename: safeFilename(body?.filename),
      contentType,
      size: buffer.length,
      data: new Binary(buffer),
      uploadedBy: session.user.id,
      createdAt: new Date(),
    };

    await imagesCollection.insertOne(document);

    response.status(201).json({
      url: `${publicApiUrl()}/api/images/${document._id.toString()}`,
    });
  } catch (error) {
    console.error("Image upload failed", error);
    response
      .status(500)
      .json({ message: "The image could not be uploaded. Please try again." });
  }
}

/** GET /api/images/:id — public so menu and profile images can render. */
export async function imageHandler(request: Request, response: Response) {
  const id = request.params.id;

  if (typeof id !== "string" || !ObjectId.isValid(id)) {
    response.status(404).json({ message: "Image not found." });
    return;
  }

  try {
    const image = await imagesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!image) {
      response.status(404).json({ message: "Image not found." });
      return;
    }

    response.setHeader("Content-Type", image.contentType);
    response.setHeader(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    response.send(Buffer.from(image.data.buffer));
  } catch (error) {
    console.error("Image lookup failed", error);
    response.status(500).json({ message: "The image could not be loaded." });
  }
}
