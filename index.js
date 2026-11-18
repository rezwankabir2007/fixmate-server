
import "dotenv/config";

import express from "express";
import cors from "cors";
import { connectToMongoDB } from "./config/db.js";
import adminRoutes from "./routes/admin.routes.js";
import authRoutes from "./routes/auth.routes.js";
import serviceRoutes from "./routes/service.routes.js";
import systemRoutes from "./routes/system.routes.js";
import userRoutes from "./routes/user.routes.js";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
  })
);
app.use(express.json());

app.use(systemRoutes);
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

    app.listen(PORT, () => {
      console.log(`FixMate server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
