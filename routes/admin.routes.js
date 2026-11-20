
import { Router } from "express";

import {
  listAccounts,
  moderateService,
  updateAccountRole,
  listAdminTransactions,
} from "../controllers/admin.controller.js";

import {
  requireAuthUser,
  requireSameOrigin,
} from "../middleware/auth.middleware.js";

const router = Router();

// Admin: view all user accounts.
router.get(
  "/api/admin/accounts",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  listAccounts,
);

// Admin: approve or reject services.
router.patch(
  "/api/admin/services/:id",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  moderateService,
);

// Admin: update customer or technician role.
router.patch(
  "/api/admin/accounts/:id/role",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  updateAccountRole,
);

// Admin: view all transactions and revenue summary.
router.get(
  "/api/admin/transactions",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  listAdminTransactions,
);

export default router;
