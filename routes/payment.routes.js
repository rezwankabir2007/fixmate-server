import { Router } from "express";

import {
  createCheckoutSession,
  getCustomerPaymentHistory,
  handleStripeWebhook,
} from "../controllers/payment.controller.js";

import {
  requireAuthUser,
  requireSameOrigin,
} from "../middleware/auth.middleware.js";

const router = Router();

// Customer creates a Stripe Checkout Session.
router.post(
  "/api/payments/checkout",
  requireSameOrigin,
  requireAuthUser("customer", "Only customers can make payments."),
  createCheckoutSession
);

// Customer views their own payment history.
router.get(
  "/api/payments/history",
  requireAuthUser("customer", "Only customers can view payment history."),
  getCustomerPaymentHistory
);

// Stripe webhook.
router.post(
  "/api/payments/webhook",
  handleStripeWebhook
);

export default router;