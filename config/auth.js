import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { getDatabase, mongoClient } from "./db.js";

export const auth = betterAuth({
  baseURL: process.env.CLIENT_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(getDatabase(), {
    client: mongoClient,
  }),
  advanced: {
    trustedProxyHeaders: true,
  },
  trustedOrigins: [process.env.CLIENT_URL || "http://localhost:3000"],
  user: {
    additionalFields: {
      role: {
        type: ["customer", "technician", "admin"],
        required: true,
        defaultValue: "customer",
        input: true,
        returned: true,
      },
    },
  },
  emailAndPassword: {
    enabled: true,
  },
});
