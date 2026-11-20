
import "dotenv/config";

import express from "express";
import cors from "cors";

import { connectToMongoDB } from "./config/db.js";

import adminRoutes from "./routes/admin.routes.js";
import authRoutes from "./routes/auth.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import serviceRoutes from "./routes/service.routes.js";
import systemRoutes from "./routes/system.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import userRoutes from "./routes/user.routes.js";

import { ensureBookingIndexes } from "./models/booking.model.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Allowed frontend origins
const allowedOrigins = [
  "http://localhost:3000",
  process.env.CLIENT_URL,
].filter(Boolean);

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// Initialize MongoDB and booking indexes once per server instance
let databaseInitializationPromise;

async function initializeDatabase() {
  if (!databaseInitializationPromise) {
    databaseInitializationPromise = (async () => {
      await connectToMongoDB();

      try {
        await ensureBookingIndexes();
      } catch (error) {
        console.warn(
          "Failed to ensure booking indexes:",
          error?.message ?? error,
        );
      }
    })().catch((error) => {
      databaseInitializationPromise = undefined;
      throw error;
    });
  }

  return databaseInitializationPromise;
}

// Ensure database is ready before handling API requests
app.use(async (req, res, next) => {
  try {
    await initializeDatabase();
    next();
  } catch (error) {
    console.error("Database initialization failed:", error);

    res.status(503).json({
      success: false,
      message: "Database is temporarily unavailable.",
    });
  }
});

// Stripe webhook must receive the original raw request body.
// Register this BEFORE express.json().
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
);

// Parse JSON for other API requests
app.use(express.json());

// Application routes
app.use(systemRoutes);
app.use(uploadRoutes);
app.use(bookingRoutes);
app.use("/api/auth", authRoutes);
app.use(userRoutes);
app.use(serviceRoutes);
app.use(adminRoutes);

// Stripe payment routes
app.use(paymentRoutes);

// JSON parsing error handler
app.use((error, req, res, next) => {
  if (error?.type !== "entity.parse.failed") {
    return next(error);
  }

  if (req.path === "/api/auth/admin/setup") {
    return res.status(400).json({
      error: "Request body must be valid JSON.",
    });
  }

  if (req.path.startsWith("/api/auth/")) {
    return res.status(400).json({
      message: "Invalid JSON body.",
    });
  }

  return res.status(400).json({
    error: "Request body must be valid JSON.",
  });
});

// Local development server
// Vercel uses the exported Express app.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`FixMate server running on port ${PORT}`);
  });
}

// Export Express app for Vercel
export default app;
