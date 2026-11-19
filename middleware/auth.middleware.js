import { fromNodeHeaders } from "better-auth/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth } from "../config/auth.js";
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
      role: payload.role ? String(payload.role) : "customer",
    };
  } catch {
    return null;
  }
}

export function requireAuthUser(role, denialMessage = "Sign in to continue.") {
  return async (req, res, next) => {
    let user = null;

    const jwtUser = await verifyBearerJwt(req.headers.authorization);
    if (jwtUser) {
      user = jwtUser;
    }

    if (!user) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
        query: { disableCookieCache: true },
      });

      if (session?.user) {
        user = {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role: session.user.role,
        };
      }
    }

    if (!user) {
      return sendError(res, denialMessage, 401);
    }

    if (role && user.role !== role) {
      return sendError(res, denialMessage, 403);
    }

    req.authUser = user;
    next();
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
    if (origin.host !== host || origin.protocol !== `${protocol}:`) {
      return sendError(res, "Request origin is not allowed.", 403);
    }
  } catch {
    return sendError(res, "Request origin is not allowed.", 403);
  }

  next();
}

export function enforcePublicAuthRules(req, res, next) {
  if (req.method !== "POST") return next();

  const path = req.originalUrl.split("?")[0].replace(/\/+$/, "");
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
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

  next();
}