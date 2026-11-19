import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
// Better Auth-এর সার্ভার সাইড JWT প্লাগিন ইম্পোর্ট করা হয়েছে
import { jwt } from "better-auth/plugins";
import { getDatabase, mongoClient } from "./db.js";

export const auth = betterAuth({
  baseURL: process.env.CLIENT_URL || "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET,
  database: mongodbAdapter(getDatabase(), {
    client: mongoClient,
  }),
  // আপনার আগের advanced সেটিংস অক্ষত রাখা হয়েছে
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
  // JWT প্লাগিন যুক্ত করা হয়েছে যাতে /api/auth/token থেকে JWT ইস্যু ও /api/auth/jwks দিয়ে ভেরিফাই করা যায়
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
  // plugins-এর পরে সেশন সেটিংস (প্রয়োজন অনুযায়ী)
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
});