import { Router } from "express";
import { listAccounts, moderateService } from "../controllers/admin.controller.js";
import { requireAuthUser, requireSameOrigin } from "../middleware/auth.middleware.js";

const router = Router();

router.get(
  "/api/admin/accounts",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  listAccounts,
);

router.patch(
  "/api/admin/services/:id",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  moderateService,
);

export default router;
