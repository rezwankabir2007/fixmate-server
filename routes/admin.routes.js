import { Router } from "express";
import { moderateService } from "../controllers/admin.controller.js";
import { requireAuthUser, requireSameOrigin } from "../middleware/auth.middleware.js";

const router = Router();

router.patch(
  "/api/admin/services/:id",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  moderateService,
);

export default router;
