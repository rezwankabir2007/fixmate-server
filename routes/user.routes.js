import { Router } from "express";
import { getProfile, updateProfile } from "../controllers/user.controller.js";
import { requireAuthUser, requireSameOrigin } from "../middleware/auth.middleware.js";

const router = Router();

router.get(
  "/api/dashboard/profile",
  requireSameOrigin,
  requireAuthUser(undefined, "Sign in to view your profile."),
  getProfile,
);

router.patch(
  "/api/dashboard/profile",
  requireSameOrigin,
  requireAuthUser(undefined, "Sign in to update your profile."),
  updateProfile,
);

export default router;
