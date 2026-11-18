import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../config/auth.js";
import { sendError } from "../utils/response.js";

export async function updateProfile(req, res) {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.name !== "string") {
    return sendError(res, "A profile name is required.", 400);
  }

  const name = body.name.trim();
  if (name.length < 2 || name.length > 80) {
    return sendError(res, "Name must be between 2 and 80 characters.", 400);
  }

  try {
    await auth.api.updateUser({
      headers: fromNodeHeaders(req.headers),
      body: { name },
    });
    return res.status(200).json({ data: { id: req.authUser.id, name } });
  } catch (error) {
    console.error(`Failed to update profile for "${req.authUser.id}".`, error);
    return sendError(res, "Profile update is temporarily unavailable.", 500);
  }
}
