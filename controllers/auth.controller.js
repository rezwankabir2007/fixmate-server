import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../config/auth.js";
import { sendError } from "../utils/response.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function setupAdmin(req, res) {
  const expectedSecret = process.env.ADMIN_SETUP_KEY;
  if (!expectedSecret || expectedSecret.length < 32) {
    return sendError(res, "Admin setup is not configured.", 503);
  }

  const body = req.body;
  if (!isRecord(body)) {
    return sendError(res, "Admin account details are required.", 400);
  }

  const secret =
    typeof body.secret === "string"
      ? body.secret
      : req.headers["x-admin-setup-key"];
  if (!secret || secret !== expectedSecret) {
    return sendError(res, "Unauthorized admin bootstrap request.", 401);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!email || !password || !name) {
    return sendError(res, "Email, password, and name are required.", 400);
  }

  try {
    const result = await auth.api.signUpEmail({
      headers: fromNodeHeaders(req.headers),
      body: { email, password, name, role: "admin" },
    });
    return res.status(200).json({ success: true, user: result.user });
  } catch (error) {
    console.error("Admin bootstrap failed.", error);
    const message = error instanceof Error ? error.message : "Admin account could not be created.";
    return sendError(res, message, 400);
  }
}
