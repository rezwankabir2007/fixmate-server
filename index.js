
import "dotenv/config";

import express from "express";
import cors from "cors";
import { connectToMongoDB } from "./config/db.js";
import adminRoutes from "./routes/admin.routes.js";
import authRoutes from "./routes/auth.routes.js";
import bookingRoutes from "./routes/booking.routes.js";
import serviceRoutes from "./routes/service.routes.js";
import systemRoutes from "./routes/system.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import userRoutes from "./routes/user.routes.js";
import { ensureBookingIndexes } from "./models/booking.model.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
 cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true,
})
);
app.use(express.json());

app.use(systemRoutes);
app.use(uploadRoutes);
app.use(bookingRoutes);
app.use("/api/auth", authRoutes);
app.use(userRoutes);
app.use(serviceRoutes);
app.use(adminRoutes);

app.use((error, req, res, next) => {
  if (error?.type !== "entity.parse.failed") return next(error);

  if (req.path === "/api/auth/admin/setup") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (req.path.startsWith("/api/auth/")) {
    return res.status(400).json({ message: "Invalid JSON body." });
  }
  return res.status(400).json({ error: "Request body must be valid JSON." });
});

async function startServer() {
  try {
    await connectToMongoDB();

    try {
      await ensureBookingIndexes();
    } catch (error) {
      // Index creation must never block startup; queries still work without
      // them, they only run slower at scale.
      console.warn("Failed to ensure booking indexes:", error?.message ?? error);
    }

    app.listen(PORT, () => {
      console.log(`FixMate server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
