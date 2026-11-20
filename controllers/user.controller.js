
import { fromNodeHeaders } from "better-auth/node";
import { ObjectId } from "mongodb";
import { auth } from "../config/auth.js";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";

// GET /api/dashboard/profile — current account profile.
export async function getProfile(req, res) {
  try {
    const lookup = [{ id: req.authUser.id }];

    if (ObjectId.isValid(req.authUser.id)) {
      lookup.push({ _id: new ObjectId(req.authUser.id) });
    }

    const record = await getDatabase()
      .collection("user")
      .findOne(
        { $or: lookup },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            createdAt: 1,
            emailVerified: 1,
          },
        },
      );

    if (!record) {
      return sendError(res, "Account not found.", 404);
    }

    return res.status(200).json({
      data: {
        id: record.id || String(record._id),
        name: record.name ?? "",
        email: record.email ?? "",
        image: record.image ?? null,
        role: record.role ?? req.authUser.role,
        emailVerified: record.emailVerified === true,
        createdAt:
          record.createdAt instanceof Date
            ? record.createdAt.toISOString()
            : record.createdAt ?? null,
      },
    });
  } catch (error) {
    console.error(
      `Failed to load profile for "${req.authUser.id}".`,
      error,
    );

    return sendError(
      res,
      "Profile details are temporarily unavailable.",
      500,
    );
  }
}

// PATCH /api/dashboard/profile — update current account profile.
export async function updateProfile(req, res) {
  const body = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof body.name !== "string"
  ) {
    return sendError(res, "A profile name is required.", 400);
  }

  const name = body.name.trim();

  if (name.length < 2 || name.length > 80) {
    return sendError(
      res,
      "Name must be between 2 and 80 characters.",
      400,
    );
  }

  const updateData = { name };

  if (body.image !== undefined) {
    if (
      typeof body.image !== "string" ||
      body.image.length > 2048
    ) {
      return sendError(res, "Invalid profile image URL.", 400);
    }

    try {
      const imageUrl = new URL(body.image);

      if (
        imageUrl.protocol !== "https:" ||
        imageUrl.hostname !== "res.cloudinary.com"
      ) {
        return sendError(res, "Invalid profile image URL.", 400);
      }

      updateData.image = imageUrl.toString();
    } catch {
      return sendError(res, "Invalid profile image URL.", 400);
    }
  }

  try {
    await auth.api.updateUser({
      headers: fromNodeHeaders(req.headers),
      body: updateData,
    });

    return res.status(200).json({
      data: {
        id: req.authUser.id,
        name,
        image: updateData.image ?? req.authUser.image ?? null,
      },
    });
  } catch (error) {
    console.error(
      `Failed to update profile for "${req.authUser.id}".`,
      error,
    );

    return sendError(
      res,
      "Profile update is temporarily unavailable.",
      500,
    );
  }
}
