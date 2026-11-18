import { Router } from "express";
import { getHealth, getRoot } from "../controllers/system.controller.js";

const router = Router();

router.get("/", getRoot);
router.get("/api/health", getHealth);

export default router;
