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
  serializeBooking,
  validateBookingInput,
} from "../models/booking.model.js";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// POST /api/bookings — customer books an approved service.
export async function createBooking(req, res) {
  const parsed = validateBookingInput(req.body);
  if ("error" in parsed) return sendError(res, parsed.error, 400);
  const { serviceId, scheduledFor, address, notes } = parsed.value;

  try {
    const service = await findBookableService(serviceId);
    if (!service) {
      return sendError(res, "Service not found or no longer available.", 404);
    }
    if (!service.technicianId) {
      return sendError(res, "This service cannot be booked right now.", 409);
    }

    const resolvedServiceId = service.id || String(service._id);
    const alreadyActive = await hasActiveBookingForService(
      resolvedServiceId,
      req.authUser.id,
    );
    if (alreadyActive) {
      return sendError(
        res,
        "You already have an active booking for this service.",
        409,
      );
    }

    // Snapshot the technician's display name for list views.
    const technicianLookup = [{ id: service.technicianId }];
    if (ObjectId.isValid(service.technicianId)) {
      technicianLookup.push({ _id: new ObjectId(service.technicianId) });
    }
    const technician = await getDatabase()
      .collection("user")
      .findOne({ $or: technicianLookup }, { projection: { name: 1 } });

    const id = new ObjectId().toHexString();
    const now = new Date();
    const booking = {
      id,
      serviceId: resolvedServiceId,
      serviceTitle: service.title ?? "Service",
      serviceCategory: service.category ?? null,
      price: typeof service.price === "number" ? service.price : null,
      technicianId: service.technicianId,
      technicianName: technician?.name ?? "Technician",
      customerId: req.authUser.id,
      customerName: req.authUser.name ?? "",
      customerEmail: req.authUser.email ?? "",
      scheduledFor,
      address,
      notes: notes || null,
      status: "pending",
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

// GET /api/bookings/mine — bookings the signed-in user created as a customer.
export async function listMyBookings(req, res) {
  try {
    const records = await bookingsCollection()
      .find({ customerId: req.authUser.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();

    return res.status(200).json({ data: records.map(serializeBooking) });
  } catch (error) {
    console.error(`Failed to list bookings for "${req.authUser.id}".`, error);
    return sendError(res, "Your bookings could not be loaded.", 500);
  }
}

// GET /api/bookings/assigned — bookings on services owned by this technician.
export async function listAssignedBookings(req, res) {
  try {
    const records = await bookingsCollection()
      .find({ technicianId: req.authUser.id })
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
      booking.customerId === user.id || booking.technicianId === user.id;
    if (user.role !== "admin" && !isParticipant) {
      return sendError(res, "Booking not found.", 404);
    }

    return res.status(200).json({ data: serializeBooking(booking) });
  } catch (error) {
    console.error(`Failed to load booking "${req.params.id}".`, error);
    return sendError(res, "Booking details are temporarily unavailable.", 500);
  }
}

// PATCH /api/bookings/:id/status — customer cancels, technician accepts /
// declines / completes. Admin may apply any valid status.
export async function updateBookingStatus(req, res) {
  const body = req.body;
  if (!isRecord(body) || !("status" in body)) {
    return sendError(res, "A booking status is required.", 400);
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
    const isCustomer = booking.customerId === user.id;
    const isTechnician = booking.technicianId === user.id;

    if (user.role === "customer" && !isCustomer) {
      return sendError(res, "Booking not found.", 404);
    }
    if (user.role === "technician" && !isTechnician) {
      return sendError(res, "Booking not found.", 404);
    }
    if (user.role !== "admin" && user.role !== "customer" && user.role !== "technician") {
      return sendError(res, "This action is not allowed for your account.", 403);
    }

    if (!canTransition(booking.status, nextStatus, user.role)) {
      return sendError(
        res,
        `A ${booking.status} booking cannot be moved to ${nextStatus}.`,
        409,
      );
    }

    const lookup = [{ id: booking.id }];
    if (ObjectId.isValid(booking.id)) {
      lookup.push({ _id: new ObjectId(booking.id) });
    }

    const result = await bookingsCollection().updateOne(
      { $or: lookup },
      {
        $set: {
          status: nextStatus,
          updatedAt: new Date(),
          statusUpdatedAt: new Date(),
          statusUpdatedBy: user.id,
        },
      },
    );
    if (result.matchedCount === 0) {
      return sendError(res, "Booking not found.", 404);
    }

    return res.status(200).json({
      data: { ...serializeBooking(booking), status: nextStatus },
    });
  } catch (error) {
    console.error(`Failed to update booking "${req.params.id}".`, error);
    return sendError(res, "The booking could not be updated.", 500);
  }
}
