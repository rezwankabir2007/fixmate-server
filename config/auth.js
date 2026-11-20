
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";

import { getDatabase, mongoClient } from "./db.js";

const trustedOrigins = [
  process.env.CLIENT_URL,
  ...(process.env.NODE_ENV !== "production"
    ? ["http://localhost:3000"]
    : []),
].filter(Boolean);

export const auth = betterAuth({
  baseURL:
    process.env.BETTER_AUTH_URL || "http://localhost:5000",

  // Better Auth default basePath is /api/auth
  secret: process.env.BETTER_AUTH_SECRET,

  database: mongodbAdapter(getDatabase(), {
    client: mongoClient,
  }),

  advanced: {
    trustedProxyHeaders: true,
  },

  trustedOrigins,

  user: {
    additionalFields: {
      role: {
        type: ["customer", "technician", "admin"],
        required: true,
        defaultValue: "customer",
        input: false,
        returned: true,
      },
    },
  },

  emailAndPassword: {
    enabled: true,
  },

  plugins: [
    jwt({
      jwt: {
        definePayload: ({ user }) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role ?? "customer",
        }),
      },
    }),
  ],

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 30 * 24 * 60 * 60,
    },
  },
});
