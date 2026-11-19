
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth } from "../config/auth.js";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";

const authBaseUrl =
  process.env.BETTER_AUTH_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:3000";

const jwksUrl = new URL("/api/auth/jwks", authBaseUrl);
const JWKS = createRemoteJWKSet(jwksUrl);

async function verifyBearerJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS);
    const id = payload.id || payload.sub;

    if (!id) return null;

    return {
      id: String(id),
      name: payload.name ? String(payload.name) : "",
      email: payload.email ? String(payload.email) : "",
    };
  } catch {
    return null;
  }
}

// Always read the current account and role from MongoDB.
async function getCurrentUser(userId) {
  const lookup = [{ id: userId }];

  if (ObjectId.isValid(userId)) {
    lookup.push({ _id: new ObjectId(userId) });
  }

  const record = await getDatabase()
    .collection("user")
    .findOne({ $or: lookup });

  if (!record) return null;

  return {
    id: record.id || String(record._id),
    name: record.name ?? "",
    email: record.email ?? "",
    role: record.role ?? "customer",
  };
}

export function requireAuthUser(
  role,
  denialMessage = "Sign in to continue.",
) {
  return async (req, res, next) => {
    try {
      let userIdentity = await verifyBearerJwt(
        req.headers.authorization,
      );

      if (!userIdentity) {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
          query: { disableCookieCache: true },
        });

        if (session?.user) {
          userIdentity = {
            id: String(session.user.id),
            name: session.user.name ?? "",
            email: session.user.email ?? "",
          };
        }
      }

      if (!userIdentity) {
        return sendError(res, denialMessage, 401);
      }

      // Do not trust the role inside an old JWT or cached session.
      const currentUser = await getCurrentUser(userIdentity.id);

      if (!currentUser) {
        return sendError(res, "User account no longer exists.", 401);
      }

      if (role && currentUser.role !== role) {
        return sendError(res, denialMessage, 403);
      }

      req.authUser = currentUser;
      return next();
    } catch (error) {
      console.error("Authentication verification failed:", error);
      return sendError(res, "Authentication verification failed.", 500);
    }
  };
}

export function requireSameOrigin(req, res, next) {
  const originHeader = req.headers.origin;
  const forwardedHost = req.headers["x-forwarded-host"];

  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || req.headers.host;

  const forwardedProtocol = req.headers["x-forwarded-proto"];

  const protocol = Array.isArray(forwardedProtocol)
    ? forwardedProtocol[0]
    : forwardedProtocol || req.protocol;

  if (!originHeader || !host) {
    return sendError(res, "Request origin is not allowed.", 403);
  }

  try {
    const origin = new URL(originHeader);

    if (
      origin.host !== host ||
      origin.protocol !== `${protocol}:`
    ) {
      return sendError(res, "Request origin is not allowed.", 403);
    }
  } catch {
    return sendError(res, "Request origin is not allowed.", 403);
  }

  return next();
}

export function enforcePublicAuthRules(req, res, next) {
  if (req.method !== "POST") return next();

  const path = req.originalUrl.split("?")[0].replace(/\/+$/, "");
  const body = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return next();
  }

  if (path.endsWith("/update-user") && "role" in body) {
    return res.status(403).json({
      message: "Account roles cannot be changed through public profile updates.",
    });
  }

  if (
    path.endsWith("/sign-up/email") &&
    "role" in body &&
    body.role !== "customer" &&
    body.role !== "technician"
  ) {
    return res.status(403).json({
      message: "Public registration is limited to customer and technician accounts.",
    });
  }

  return next();
}
