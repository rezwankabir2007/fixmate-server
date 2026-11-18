import { Router } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../config/auth.js";
import { setupAdmin } from "../controllers/auth.controller.js";
import { enforcePublicAuthRules } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/admin/setup", setupAdmin);
router.all("/*splat", enforcePublicAuthRules, toNodeHandler(auth));

export default router;
