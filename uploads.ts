import type { Request, Response } from "express";

import { auth, toRequestHeaders } from "./auth.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

interface ImgbbResponse {
  data?: {
    url?: string;
    display_url?: string;
    thumb?: { url?: string };
  };
  success?: boolean;
  error?: { message?: string };
}

function safeFilename(value: unknown) {
  if (typeof value !== "string") {
    return "pizza-hub-image";
  }

  return (
    value
      .replace(/\.[A-Za-z0-9]+$/, "")
      .replace(/[^\w.\- ]+/g, "_")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "pizza-hub-image"
  );
}

/**
 * Uploads a base64 payload to ImgBB and returns the public image URL.
 * `IMGBB_API_KEY` lives only on the API server, never in the browser bundle.
 */
async function uploadToImgbb(base64: string, name: string) {
  const apiKey = process.env.IMGBB_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Image hosting is not configured. Add IMGBB_API_KEY to the API server.",
    );
  }

  const form = new FormData();
  form.set("key", apiKey);
  form.set("image", base64);
  form.set("name", name);

  const response = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(25000),
  });

  const payload = (await response.json().catch(() => null)) as
    | ImgbbResponse
    | null;

  const url = payload?.data?.display_url ?? payload?.data?.url;

  if (!response.ok || !payload?.success || !url) {
    throw new Error(
      payload?.error?.message ||
        "ImgBB rejected the image upload. Please try another image.",
    );
  }

  return url;
}

/**
 * POST /api/uploads
 *
 * Authenticated image upload used by menu items and profile pictures. The file
 * is forwarded to ImgBB (max 5MB) and only the returned URL is persisted in
 * MongoDB, so the database never stores binary image data.
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

    if ((session.user as { isBlocked?: unknown }).isBlocked === true) {
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

    const url = await uploadToImgbb(encoded, safeFilename(body?.filename));

    response.status(201).json({ url, provider: "imgbb" });
  } catch (error) {
    console.error("Image upload failed", error);
    response.status(502).json({
      message:
        error instanceof Error
          ? error.message
          : "The image could not be uploaded. Please try again.",
    });
  }
}
