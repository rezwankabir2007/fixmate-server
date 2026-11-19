
import { Router } from "express";
import {
  listAccounts,
  moderateService,
  updateAccountRole,
} from "../controllers/admin.controller.js";
import {
  requireAuthUser,
  requireSameOrigin,
} from "../middleware/auth.middleware.js";

const router = Router();

// Get all user accounts (Admin only)
router.get(
  "/api/admin/accounts",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  listAccounts,
);

// Approve or reject services (Admin only)
router.patch(
  "/api/admin/services/:id",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  moderateService,
);

// Update a customer's or technician's role (Admin only)
router.patch(
  "/api/admin/accounts/:id/role",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  updateAccountRole,
);

export default router;
