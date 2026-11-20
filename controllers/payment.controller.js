
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

function getStripeCurrency() {
  const currency = (
    process.env.STRIPE_CURRENCY || "usd"
  ).toLowerCase();

  if (currency !== "usd") {
    throw new Error("Unsupported Stripe currency.");
  }

  return currency;
}

function isCustomerOwner(booking, user) {
  return (
    (Boolean(user?.email) &&
      booking.customerEmail === user.email) ||
    (Boolean(user?.id) &&
      String(booking.customerId) === String(user.id))
  );
}

function getBookingLookup(booking) {
  const lookup = [];

  if (booking.id) {
    lookup.push({ id: String(booking.id) });
  }

  if (booking._id) {
    lookup.push({ _id: booking._id });
  }

  return { $or: lookup };
}

function getBookingId(booking) {
  return String(booking.id || booking._id || "");
}

function toISOString(value) {
  if (!value) return null;

  const date = value instanceof Date
    ? value
    : new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

// POST /api/payments/checkout
export async function createCheckoutSession(req, res) {
  const user = req.authUser;
  const bookingId = req.body?.bookingId;

  if (
    typeof bookingId !== "string" ||
    !bookingId.trim()
  ) {
    return sendError(
      res,
      "A valid booking ID is required.",
      400
    );
  }

  let paymentId = null;

  try {
    if (!user?.id) {
      return sendError(
        res,
        "Authenticated customer not found.",
        401
      );
    }

    const stripe = getStripe();
    const currency = getStripeCurrency();

    const booking = await findBookingById(
      bookingId.trim()
    );

    if (!booking || !isCustomerOwner(booking, user)) {
      return sendError(
        res,
        "Booking not found.",
        404
      );
    }

    if (booking.status !== "completed") {
      return sendError(
        res,
        "Only completed bookings can be paid.",
        409
      );
    }

    if (booking.paymentStatus === "paid") {
      return sendError(
        res,
        "This booking has already been paid.",
        409
      );
    }

    const amount = Number(booking.finalAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return sendError(
        res,
        "The final booking amount is invalid.",
        400
      );
    }

    const amountInCents = Math.round(amount * 100);

    if (
      Math.abs(amountInCents / 100 - amount) > 0.000001
    ) {
      return sendError(
        res,
        "The booking amount cannot have more than two decimal places.",
        400
      );
    }

    const clientUrl = process.env.CLIENT_URL;

    if (!clientUrl) {
      return sendError(
        res,
        "CLIENT_URL is not configured.",
        503
      );
    }

    const payments = getDatabase().collection("payments");
    const bookingKey = getBookingId(booking);

    const existingPayment = await payments.findOne({
      bookingId: bookingKey,
      customerId: String(user.id),
      status: "pending",
      sessionId: { $exists: true, $ne: null },
    });

    if (existingPayment?.sessionId) {
      const existingSession =
        await stripe.checkout.sessions.retrieve(
          existingPayment.sessionId
        );

      if (
        existingSession.status === "open" &&
        existingSession.url
      ) {
        const updatedSession =
          await stripe.checkout.sessions.update(
            existingSession.id,
            {
              metadata: {
                paymentId: String(existingPayment._id),
                bookingId: bookingKey,
                customerId: String(user.id),
              },
            }
          );

        return res.status(200).json({
          data: {
            checkoutUrl: updatedSession.url,
          },
        });
      }

      if (
        existingSession.status === "complete" &&
        existingSession.payment_status === "paid"
      ) {
        return sendError(
          res,
          "Your previous payment is being processed. Please wait.",
          409
        );
      }

      await payments.updateOne(
        {
          _id: existingPayment._id,
          status: "pending",
        },
        {
          $set: {
            status: "expired",
            updatedAt: new Date(),
          },
        }
      );
    }

    paymentId = new ObjectId();
    const now = new Date();

    await payments.insertOne({
      _id: paymentId,
      bookingId: bookingKey,
      customerId: String(user.id),
      customerEmail: user.email,
      amount,
      currency,
      status: "pending",
      sessionId: null,
      paymentIntentId: null,
      createdAt: now,
      updatedAt: now,
    });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: user.email,
        client_reference_id: bookingKey,
        metadata: {
          paymentId: String(paymentId),
          bookingId: bookingKey,
          customerId: String(user.id),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amountInCents,
              product_data: {
                name:
                  booking.serviceTitle ||
                  "FixMate Repair Service",
                description: `Booking ID: ${bookingKey}`,
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
        }
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
        }
      );

      throw error;
    }
  } catch (error) {
    console.error(
      "Failed to create Stripe Checkout Session:",
      error
    );

    return sendError(
      res,
      "Online payment could not be started.",
      500
    );
  }
}

// GET /api/payments/history
// Returns payment history belonging only to the authenticated customer.
export async function getCustomerPaymentHistory(req, res) {
  const user = req.authUser;

  try {
    if (!user?.id) {
      return sendError(
        res,
        "Authenticated customer not found.",
        401
      );
    }

    const paymentsCollection =
      getDatabase().collection("payments");

    // Always use the authenticated user's ID.
    const payments = await paymentsCollection
      .find({
        customerId: String(user.id),
      })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    const bookingIds = [
      ...new Set(
        payments
          .map((payment) => String(payment.bookingId || ""))
          .filter(Boolean)
      ),
    ];

    let bookings = [];

    if (bookingIds.length > 0) {
      const bookingLookup = [
        { id: { $in: bookingIds } },
      ];

      const objectIds = bookingIds
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      if (objectIds.length > 0) {
        bookingLookup.push({
          _id: { $in: objectIds },
        });
      }

      bookings = await getDatabase()
        .collection("bookings")
        .find({
          $or: bookingLookup,
        })
        .toArray();
    }

    const bookingMap = new Map();

    for (const booking of bookings) {
      if (booking.id) {
        bookingMap.set(
          String(booking.id),
          booking
        );
      }

      if (booking._id) {
        bookingMap.set(
          String(booking._id),
          booking
        );
      }
    }

    const history = payments.map((payment) => {
      const bookingId = String(payment.bookingId || "");
      const booking = bookingMap.get(bookingId);

      return {
        id: String(payment._id),

        transactionId:
          payment.paymentIntentId ||
          payment.sessionId ||
          String(payment._id),

        bookingId,

        bookingTitle:
          booking?.serviceTitle ||
          "Repair Service",

        technicianName:
          booking?.technicianName || "—",

        amount: payment.amount,
        currency: payment.currency,

        date: toISOString(
          payment.paidAt ||
          payment.updatedAt ||
          payment.createdAt
        ),

        status: payment.status,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        payments: history,
        total: history.length,
      },
    });
  } catch (error) {
    console.error(
      "Failed to fetch customer payment history:",
      error
    );

    return sendError(
      res,
      "Could not load payment history.",
      500
    );
  }
}

// POST /api/payments/webhook
export async function handleStripeWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers["stripe-signature"];

  if (!webhookSecret) {
    return res
      .status(503)
      .send("Stripe webhook is not configured.");
  }

  if (!signature || !Buffer.isBuffer(req.body)) {
    return res
      .status(400)
      .send("Invalid webhook request.");
  }

  let event;

  try {
    const stripe = getStripe();

    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret
    );

    console.log(
      "Stripe webhook signature verified:",
      event.type
    );
  } catch (error) {
    console.error(
      "Stripe webhook signature verification failed:",
      error
    );

    return res
      .status(400)
      .send("Invalid webhook signature.");
  }

  try {
    const payments = getDatabase().collection("payments");
    const bookings = getDatabase().collection("bookings");

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status !== "paid") {
        return res.status(200).json({
          received: true,
        });
      }

      const paymentId = session.metadata?.paymentId;

      let payment = null;

      if (paymentId && ObjectId.isValid(paymentId)) {
        payment = await payments.findOne({
          _id: new ObjectId(paymentId),
          sessionId: session.id,
        });
      }

      if (!payment) {
        payment = await payments.findOne({
          sessionId: session.id,
        });
      }

      if (!payment) {
        console.error(
          "Payment record not found:",
          session.id
        );

        return res
          .status(404)
          .send("Payment record not found.");
      }

      const bookingId = String(payment.bookingId || "");

      if (!bookingId) {
        return res
          .status(400)
          .send("Booking ID is missing.");
      }

      if (
        payment.status !== "pending" &&
        payment.status !== "succeeded"
      ) {
        return res
          .status(409)
          .send("Payment is not pending.");
      }

      const expectedAmount = Math.round(
        Number(payment.amount) * 100
      );

      if (
        !Number.isFinite(expectedAmount) ||
        session.amount_total !== expectedAmount ||
        session.currency !== payment.currency
      ) {
        console.error(
          "Payment amount or currency mismatch."
        );

        return res
          .status(400)
          .send("Payment amount or currency mismatch.");
      }

      const booking = await findBookingById(bookingId);

      if (!booking) {
        console.error(
          "Booking not found:",
          bookingId
        );

        return res
          .status(404)
          .send("Booking not found.");
      }

      if (booking.status !== "completed") {
        return res
          .status(409)
          .send("Booking is not completed.");
      }

      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null;

      const result = await bookings.updateOne(
        {
          ...getBookingLookup(booking),
          status: "completed",
          paymentStatus: { $ne: "paid" },
        },
        {
          $set: {
            paymentStatus: "paid",
            paidAt: new Date(),
            stripePaymentIntentId: paymentIntentId,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        const latestBooking =
          await findBookingById(bookingId);

        if (latestBooking?.paymentStatus !== "paid") {
          return res.status(409).send(
            "Booking payment status could not be updated."
          );
        }
      }

      await payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            status: "succeeded",
            paymentIntentId,
            paidAt: payment.paidAt || new Date(),
            updatedAt: new Date(),
          },
        }
      );

      console.log(
        "Payment successfully completed:",
        {
          paymentId: String(payment._id),
          bookingId,
          sessionId: session.id,
        }
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
        }
      );

      console.log(
        "Checkout Session expired:",
        session.id
      );
    }

    return res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error(
      "Stripe webhook processing failed:",
      error
    );

    return res
      .status(500)
      .send("Webhook processing failed.");
  }
}
