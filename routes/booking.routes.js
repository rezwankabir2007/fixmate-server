import { Router } from "express";
import { requireAuthUser, requireSameOrigin } from "../middleware/auth.middleware.js";
import {
  createBooking,
  getBookingById,
  listAllBookings,
  listAssignedBookings,
  listMyBookings,
  updateBookingStatus,
} from "../controllers/booking.controller.js";

const router = Router();

// Literal paths must be declared before "/api/bookings/:id".
router.post(
  "/api/bookings",
  requireSameOrigin,
  requireAuthUser("customer", "Sign in as a customer to book a service."),
  createBooking,
);
router.get(
  "/api/bookings/mine",
  requireSameOrigin,
  requireAuthUser(undefined, "Sign in to view your bookings."),
  listMyBookings,
);
router.get(
  "/api/bookings/assigned",
  requireSameOrigin,
  requireAuthUser("technician", "Sign in as a technician to view requests."),
  listAssignedBookings,
);
router.get(
  "/api/bookings",
  requireSameOrigin,
  requireAuthUser("admin", "Admin access is required."),
  listAllBookings,
);
router.get(
  "/api/bookings/:id",
  requireSameOrigin,
  requireAuthUser(undefined, "Sign in to view this booking."),
  getBookingById,
);
router.patch(
  "/api/bookings/:id/status",
  requireSameOrigin,
  requireAuthUser(undefined, "Sign in to update this booking."),
  updateBookingStatus,
);

export default router;
