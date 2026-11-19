import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";
import {
  BOOKING_STATUSES,
  bookingsCollection,
  canTransition,
  findBookableService,
  findBookingById,
  hasActiveBookingForService,
  isValidStatus,
  normalizeStatus,
  serializeBooking,
  validateBookingInput,
} from "../models/booking.model.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityFilter(user, field) {
  // Ownership always comes from the verified token/session — never from the
  // request body. The email matches the assignment contract; the stored id is
  // accepted as an equivalent server-derived identifier.
  const filter = [];
  if (user.email) filter.push({ [field]: user.email });
  if (user.id) {
    filter.push({ [field === "customerEmail" ? "customerId" : "technicianId"]: user.id });
  }
  return filter.length > 0 ? filter : [{ [field]: "__no_identity__" }];
}

function isCustomerOwner(booking, user) {
  return (
    (Boolean(user.email) && booking.customerEmail === user.email) ||
    (Boolean(user.id) && booking.customerId === user.id)
  );
}

function isAssignedTechnician(booking, user) {
  return (
    (Boolean(user.email) && booking.technicianEmail === user.email) ||
    (Boolean(user.id) && booking.technicianId === user.id)
  );
}

function parseFinalAmount(value) {
  if (typeof value === "string" && value.trim() !== "") {
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

// POST /api/bookings — customer requests a repair for an approved service.
//
// Identity: name/email/role come from the verified token/session only.
// Service + technician data are loaded from MongoDB and snapshotted into the
// booking so later catalog edits never rewrite booking history.
export async function createBooking(req, res) {
  const parsed = validateBookingInput(req.body);
  if ("error" in parsed) return sendError(res, parsed.error, 400);
  const { serviceId, customerPhone, address, preferredDate, problemDescription } =
    parsed.value;

  const user = req.authUser;
  if (!user.email) {
    return sendError(res, "Your account email is required to book a service.", 401);
  }

  try {
    const service = await findBookableService(serviceId);
    if (!service) {
      return sendError(res, "Service not found or no longer available.", 404);
    }

    const resolvedServiceId = service.id || String(service._id);
    const ownerFilter = identityFilter(user, "customerEmail");
    const alreadyActive = await hasActiveBookingForService(
      resolvedServiceId,
      ownerFilter,
    );
    if (alreadyActive) {
      return sendError(
        res,
        "You already have an active request for this service.",
        409,
      );
    }

    // Resolve the assigned technician from the service record / user
    // collection — the client never supplies technician identity.
    let technicianEmail =
      typeof service.technicianEmail === "string"
        ? service.technicianEmail.trim()
        : "";
    let technicianName =
      typeof service.technicianName === "string"
        ? service.technicianName.trim()
        : "";

    const userCollection = getDatabase().collection("user");
    if (!technicianEmail && service.technicianId) {
      const lookup = [{ id: service.technicianId }];
      if (ObjectId.isValid(service.technicianId)) {
        lookup.push({ _id: new ObjectId(service.technicianId) });
      }
      const technician = await userCollection.findOne(
        { $or: lookup },
        { projection: { name: 1, email: 1 } },
      );
      technicianEmail = technician?.email ?? "";
      technicianName = technicianName || technician?.name || "";
    }

    if (!technicianName && technicianEmail) {
      const technician = await userCollection.findOne(
        { email: technicianEmail },
        { projection: { name: 1 } },
      );
      technicianName = technician?.name || "";
    }

    if (!technicianEmail) {
      return sendError(res, "This service cannot be booked right now.", 409);
    }

    const now = new Date();
    const booking = {
      _id: new ObjectId(),
      serviceId: resolvedServiceId,
      serviceTitle: service.title ?? "Service",
      serviceImage: service.image ?? "",
      category: service.category ?? null,
      basePrice:
        typeof service.basePrice === "number"
          ? service.basePrice
          : typeof service.price === "number"
            ? service.price
            : null,
      technicianName: technicianName || "Technician",
      technicianEmail,
      customerId: user.id,
      technicianId:
        typeof service.technicianId === "string" ? service.technicianId : null,
      customerName: user.name ?? "",
      customerEmail: user.email,
      customerPhone,
      address,
      preferredDate,
      problemDescription,
      status: "requested",
      finalAmount: null,
      paymentStatus: "unpaid",
      createdAt: now,
      updatedAt: now,
    };

    await bookingsCollection().insertOne(booking);
    return res.status(201).json({ data: serializeBooking(booking) });
  } catch (error) {
    console.error("Failed to create booking.", error);
    return sendError(res, "Bookings are temporarily unavailable.", 500);
  }
}

// GET /api/bookings/mine — bookings the signed-in customer owns.
export async function listMyBookings(req, res) {
  try {
    const records = await bookingsCollection()
      .find({ $or: identityFilter(req.authUser, "customerEmail") })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();

    return res.status(200).json({ data: records.map(serializeBooking) });
  } catch (error) {
    console.error(`Failed to list bookings for "${req.authUser.id}".`, error);
    return sendError(res, "Your bookings could not be loaded.", 500);
  }
}

// GET /api/bookings/assigned — bookings assigned to this technician.
export async function listAssignedBookings(req, res) {
  try {
    const records = await bookingsCollection()
      .find({ $or: identityFilter(req.authUser, "technicianEmail") })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();

    return res.status(200).json({ data: records.map(serializeBooking) });
  } catch (error) {
    console.error(
      `Failed to list assigned bookings for "${req.authUser.id}".`,
      error,
    );
    return sendError(res, "Booking requests could not be loaded.", 500);
  }
}

// GET /api/bookings — admin overview with optional ?status filter.
export async function listAllBookings(req, res) {
  const searchParams = new URL(req.originalUrl, "http://localhost").searchParams;
  const status = searchParams.get("status");
  if (status && !isValidStatus(status)) {
    return sendError(res, "Unknown booking status filter.", 400);
  }

  try {
    const filter = status ? { status } : {};
    const [records, total] = await Promise.all([
      bookingsCollection()
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(200)
        .toArray(),
      bookingsCollection().countDocuments(filter),
    ]);

    return res.status(200).json({
      data: records.map(serializeBooking),
      total,
      statuses: BOOKING_STATUSES,
    });
  } catch (error) {
    console.error("Failed to list all bookings.", error);
    return sendError(res, "Booking records could not be loaded.", 500);
  }
}

// GET /api/bookings/:id — participant or admin only.
export async function getBookingById(req, res) {
  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return sendError(res, "Booking not found.", 404);

    const user = req.authUser;
    const isParticipant =
      isCustomerOwner(booking, user) || isAssignedTechnician(booking, user);
    if (user.role !== "admin" && !isParticipant) {
      return sendError(res, "Booking not found.", 404);
    }

    return res.status(200).json({ data: serializeBooking(booking) });
  } catch (error) {
    console.error(`Failed to load booking "${req.params.id}".`, error);
    return sendError(res, "Booking details are temporarily unavailable.", 500);
  }
}

// PATCH /api/bookings/:id/status — strict, server-enforced lifecycle:
//
//   requested -> accepted / rejected (assigned technician)
//   requested -> cancelled          (booking owner)
//   accepted  -> in-progress        (assigned technician)
//   in-progress -> completed        (assigned technician, finalAmount > 0)
//
// paymentStatus is never accepted from the client; the only "paid" path is
// the future verified payment flow. Invalid transitions and repeated actions
// are rejected, and the update is conditional on the current status so
// concurrent requests cannot double-apply a transition.
export async function updateBookingStatus(req, res) {
  const body = req.body;
  if (!isRecord(body) || !("status" in body)) {
    return sendError(res, "A booking status is required.", 400);
  }

  if ("paymentStatus" in body) {
    return sendError(
      res,
      "Payment status cannot be changed from the client.",
      400,
    );
  }

  const nextStatus = body.status;
  if (!isValidStatus(nextStatus)) {
    return sendError(
      res,
      `Status must be one of: ${BOOKING_STATUSES.join(", ")}.`,
      400,
    );
  }

  try {
    const booking = await findBookingById(req.params.id);
    if (!booking) return sendError(res, "Booking not found.", 404);

    const user = req.authUser;
    const rawStatus = booking.status;
    const currentStatus = normalizeStatus(rawStatus);

    if (user.role === "admin") {
      return sendError(
        res,
        "Administrators cannot change booking statuses.",
        403,
      );
    }
    if (user.role === "customer") {
      if (!isCustomerOwner(booking, user)) {
        return sendError(res, "Booking not found.", 404);
      }
    } else if (user.role === "technician") {
      if (!isAssignedTechnician(booking, user)) {
        return sendError(res, "Booking not found.", 404);
      }
    } else {
      return sendError(res, "This action is not allowed for your account.", 403);
    }

    if (!canTransition(currentStatus, nextStatus, user.role)) {
      return sendError(
        res,
        `A ${currentStatus} booking cannot be moved to ${nextStatus}.`,
        409,
      );
    }

    const update = {
      status: nextStatus,
      updatedAt: new Date(),
      statusUpdatedAt: new Date(),
      statusUpdatedBy: user.id,
    };

    if (nextStatus === "completed") {
      const finalAmount = parseFinalAmount(body.finalAmount);
      if (finalAmount === null) {
        return sendError(
          res,
          "A final amount greater than 0 is required to complete this booking.",
          400,
        );
      }
      update.finalAmount = finalAmount;
      update.paymentStatus = "unpaid";
    }

    const lookup = [{ id: booking.id }];
    if (ObjectId.isValid(booking.id)) {
      lookup.push({ _id: new ObjectId(booking.id) });
    }

    // Conditional filter: only applies when the booking is still in the
    // status we just validated, preventing race conditions and replays.
    const result = await bookingsCollection().updateOne(
      { $or: lookup, status: rawStatus },
      { $set: update },
    );
    if (result.matchedCount === 0) {
      return sendError(
        res,
        "The booking changed before the update could be applied. Refresh and try again.",
        409,
      );
    }

    return res.status(200).json({
      data: serializeBooking({
        ...booking,
        ...update,
        status: nextStatus,
      }),
    });
  } catch (error) {
    console.error(`Failed to update booking "${req.params.id}".`, error);
    return sendError(res, "The booking could not be updated.", 500);
  }
}
