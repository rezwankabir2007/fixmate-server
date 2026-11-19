
import { Router } from "express";

import {
  createCheckoutSession,
  handleStripeWebhook,
} from "../controllers/payment.controller.js";

import {
  requireAuthUser,
  requireSameOrigin,
} from "../middleware/auth.middleware.js";

const router = Router();

/**
 * Customer Stripe Checkout
 *
 * POST /api/payments/checkout
 *
 * - Only authenticated customers can create payments.
 * - Same-origin protection is applied.
 * - Booking ownership and payment amount are validated
 *   inside the payment controller.
 */
router.post(
  "/api/payments/checkout",
  requireSameOrigin,
  requireAuthUser(
    "customer",
    "Only customers can make payments."
  ),
  createCheckoutSession
);

/**
 * Stripe Webhook
 *
 * POST /api/payments/webhook
 *
 * - Stripe sends payment events to this endpoint.
 * - Customer authentication is not required.
 * - Stripe signature verification is handled
 *   inside handleStripeWebhook.
 * - Express raw body middleware must run before express.json().
 */
router.post(
  "/api/payments/webhook",
  handleStripeWebhook
);

export default router;
