import { Router } from "express";
import {
  createTechnicianService,
  deleteTechnicianService,
  getPublicServiceById,
  listPublicServices,
} from "../controllers/service.controller.js";
import { requireAuthUser, requireSameOrigin } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/api/services", listPublicServices);
router.get("/api/services/:id", getPublicServiceById);
router.delete(
  "/api/technician/services/:id",
  requireSameOrigin,
  requireAuthUser("technician", "Sign in as a technician to manage services."),
  deleteTechnicianService,
);
router.post(
  "/api/technician/services",
  requireSameOrigin,
  requireAuthUser("technician", "Sign in as a technician to submit a service."),
  createTechnicianService,
);

export default router;
