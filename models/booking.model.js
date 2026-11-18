import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";

// Booking model for the Native Driver data layer (no Mongoose by project rule).
export const BOOKING_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "completed",
  "cancelled",
];

// Which role may move a booking from one status to another.
// Admin may perform any transition (operations oversight).
const ALLOWED_TRANSITIONS = {
  pending: {
    accepted: ["technician"],
    declined: ["technician"],
    cancelled: ["customer"],
  },
  accepted: {
    completed: ["technician"],
    cancelled: ["customer"],
  },
};

export function isValidStatus(value) {
  return typeof value === "string" && BOOKING_STATUSES.includes(value);
}

export function canTransition(currentStatus, nextStatus, role) {
  if (!isValidStatus(currentStatus) || !isValidStatus(nextStatus)) return false;
  if (role === "admin") return true;
  const allowedRoles = ALLOWED_TRANSITIONS[currentStatus]?.[nextStatus];
  return Array.isArray(allowedRoles) && allowedRoles.includes(role);
}

export function bookingsCollection() {
  return getDatabase().collection("bookings");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Validates the POST /api/bookings request body.
// Returns { error } on failure or { value } with normalized fields.
export function validateBookingInput(body) {
  if (!isRecord(body)) {
    return { error: "A booking object is required." };
  }

  const serviceId = text(body.serviceId);
  const address = text(body.address);
  const notes = text(body.notes);
  const rawScheduledFor = text(body.scheduledFor);

  if (!serviceId || serviceId.length > 100) {
    return { error: "A valid service is required." };
  }

  const scheduledFor = new Date(rawScheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return { error: "Provide a valid scheduled date and time." };
  }
  if (scheduledFor.getTime() <= Date.now()) {
    return { error: "The scheduled time must be in the future." };
  }

  if (address.length < 10 || address.length > 300) {
    return { error: "Service address must be between 10 and 300 characters." };
  }
  if (notes.length > 1000) {
    return { error: "Notes must be 1000 characters or fewer." };
  }

  return {
    value: { serviceId, scheduledFor, address, notes },
  };
}

// Resolves a service by its public id or _id. Only approved, bookable services.
export async function findBookableService(serviceId) {
  const lookup = [{ id: serviceId }];
  if (ObjectId.isValid(serviceId)) {
    lookup.push({ _id: new ObjectId(serviceId) });
  }

  return getDatabase()
    .collection("services")
    .findOne({ status: "approved", available: true, $or: lookup });
}

export async function findBookingById(bookingId) {
  const lookup = [{ id: bookingId }];
  if (ObjectId.isValid(bookingId)) {
    lookup.push({ _id: new ObjectId(bookingId) });
  }

  return bookingsCollection().findOne({ $or: lookup });
}

export async function hasActiveBookingForService(serviceId, customerId) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    customerId,
    status: { $in: ["pending", "accepted"] },
  });
  return Boolean(booking);
}

export async function hasActiveBookingsForService(serviceId) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    status: { $in: ["pending", "accepted"] },
  });
  return Boolean(booking);
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeBooking(record) {
  return {
    id: record.id || (record._id ? String(record._id) : ""),
    serviceId: record.serviceId ?? null,
    serviceTitle: record.serviceTitle ?? "Service",
    serviceCategory: record.serviceCategory ?? null,
    price: typeof record.price === "number" ? record.price : null,
    technicianId: record.technicianId ?? null,
    technicianName: record.technicianName ?? "Technician",
    customerId: record.customerId ?? null,
    customerName: record.customerName ?? "",
    customerEmail: record.customerEmail ?? "",
    scheduledFor: isoDate(record.scheduledFor),
    address: record.address ?? "",
    notes: record.notes ?? null,
    status: isValidStatus(record.status) ? record.status : "pending",
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  };
}
