
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { getDatabase } from "../config/db.js";
import { findBookingById } from "../models/booking.model.js";
import { sendError } from "../utils/response.js";

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  return new Stripe(secretKey);
}

function isCustomerOwner(booking, user) {
  return (
    (Boolean(user.email) && booking.customerEmail === user.email) ||
    (Boolean(user.id) && booking.customerId === user.id)
  );
}

function getBookingLookup(booking) {
  const lookup = [{ id: booking.id }];

  if (ObjectId.isValid(booking.id)) {
    lookup.push({ _id: new ObjectId(booking.id) });
  }

  return { $or: lookup };
}

// POST /api/payments/checkout
// Create a secure Stripe Checkout Session for a completed booking.
export async function createCheckoutSession(req, res) {
  const user = req.authUser;
  const bookingId = req.body?.bookingId;

  if (typeof bookingId !== "string" || !bookingId.trim()) {
    return sendError(res, "A valid booking ID is required.", 400);
  }

  try {
    const stripe = getStripe();
    const booking = await findBookingById(bookingId.trim());

    if (!booking) {
      return sendError(res, "Booking not found.", 404);
    }

    if (!isCustomerOwner(booking, user)) {
      return sendError(res, "Booking not found.", 404);
    }

    if (booking.status !== "completed") {
      return sendError(
        res,
        "Only completed bookings can be paid.",
        409,
      );
    }

    if (booking.paymentStatus === "paid") {
      return sendError(res, "This booking has already been paid.", 409);
    }

    const amount = Number(booking.finalAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return sendError(res, "The final booking amount is invalid.", 400);
    }

    // Stripe USD amounts are sent in cents.
    const amountInCents = Math.round(amount * 100);

    if (Math.abs(amountInCents / 100 - amount) > 0.000001) {
      return sendError(
        res,
        "The booking amount cannot have more than two decimal places.",
        400,
      );
    }

    const clientUrl = process.env.CLIENT_URL;

    if (!clientUrl) {
      return sendError(res, "CLIENT_URL is not configured.", 503);
    }

    const payments = getDatabase().collection("payments");

    // Reuse an existing open Checkout Session instead of creating
    // another payment session for the same booking.
    const existingPayment = await payments.findOne({
      bookingId: booking.id,
      status: "pending",
      sessionId: { $exists: true },
    });

    if (existingPayment?.sessionId) {
      const existingSession = await stripe.checkout.sessions.retrieve(
        existingPayment.sessionId,
      );

      if (
        existingSession.status === "open" &&
        existingSession.url
      ) {
        return res.status(200).json({
          data: { checkoutUrl: existingSession.url },
        });
      }

      await payments.updateOne(
        { _id: existingPayment._id, status: "pending" },
        { $set: { status: "expired", updatedAt: new Date() } },
      );
    }

    const paymentId = new ObjectId();
    const now = new Date();

    // Save the pending payment before creating the Stripe session.
    await payments.insertOne({
      _id: paymentId,
      bookingId: booking.id,
      customerId: user.id,
      customerEmail: user.email,
      amount,
      currency: "usd",
      status: "pending",
      sessionId: null,
      paymentIntentId: null,
      createdAt: now,
      updatedAt: now,
    });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: user.email,
        client_reference_id: booking.id,
        metadata: {
          paymentId: String(paymentId),
          bookingId: booking.id,
          customerId: user.id,
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountInCents,
              product_data: {
                name: booking.serviceTitle || "FixMate Repair Service",
                description: `Booking ID: ${booking.id}`,
              },
            },
          },
        ],
        success_url:
          `${clientUrl}/dashboard/customer/bookings?payment=success` +
          `&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:
          `${clientUrl}/dashboard/customer/bookings?payment=cancelled`,
      });

      await payments.updateOne(
        { _id: paymentId },
        {
          $set: {
            sessionId: session.id,
            checkoutUrl: session.url,
            updatedAt: new Date(),
          },
        },
      );

      return res.status(201).json({
        data: {
          checkoutUrl: session.url,
        },
      });
    } catch (error) {
      await payments.updateOne(
        { _id: paymentId },
        {
          $set: {
            status: "failed",
            updatedAt: new Date(),
          },
        },
      );

      throw error;
    }
  } catch (error) {
    console.error("Failed to create Stripe Checkout Session.", error);
    return sendError(
      res,
      "Online payment could not be started.",
      500,
    );
  }
}

// POST /api/payments/webhook
// Stripe calls this endpoint after payment events.
// This endpoint must receive the raw request body.
export async function handleStripeWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers["stripe-signature"];

  if (!webhookSecret) {
    return res.status(503).send("Stripe webhook is not configured.");
  }

  if (!signature || !Buffer.isBuffer(req.body)) {
    return res.status(400).send("Invalid webhook request.");
  }

  let event;

  try {
    const stripe = getStripe();

    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed.", error);
    return res.status(400).send("Invalid Stripe webhook signature.");
  }

  try {
    const payments = getDatabase().collection("payments");
    const bookings = getDatabase().collection("bookings");

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status !== "paid") {
        return res.status(200).json({ received: true });
      }

      const paymentId = session.metadata?.paymentId;
      const bookingId = session.metadata?.bookingId;

      if (
        !paymentId ||
        !ObjectId.isValid(paymentId) ||
        !bookingId
      ) {
        return res.status(400).send("Payment metadata is invalid.");
      }

      const payment = await payments.findOne({
        _id: new ObjectId(paymentId),
        bookingId,
        sessionId: session.id,
      });

      if (!payment) {
        return res.status(404).send("Payment record not found.");
      }

      if (payment.status === "succeeded") {
        return res.status(200).json({ received: true });
      }

      const booking = await findBookingById(bookingId);

      if (!booking) {
        return res.status(404).send("Booking not found.");
      }

      if (booking.status !== "completed") {
        return res.status(409).send("Booking is not completed.");
      }

      if (booking.paymentStatus !== "paid") {
        const result = await bookings.updateOne(
          {
            ...getBookingLookup(booking),
            status: "completed",
            paymentStatus: "unpaid",
          },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
              stripePaymentIntentId:
                typeof session.payment_intent === "string"
                  ? session.payment_intent
                  : null,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          const latestBooking = await findBookingById(bookingId);

          if (latestBooking?.paymentStatus !== "paid") {
            return res.status(409).send(
              "Booking payment status could not be updated.",
            );
          }
        }
      }

      await payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            status: "succeeded",
            paymentIntentId:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : null,
            paidAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;

      await payments.updateOne(
        {
          sessionId: session.id,
          status: "pending",
        },
        {
          $set: {
            status: "expired",
            updatedAt: new Date(),
          },
        },
      );
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed.", error);
    return res.status(500).send("Webhook processing failed.");
  }
}
