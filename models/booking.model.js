import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";

// Booking model for the Native Driver data layer (no Mongoose by project rule).
//
// Status lifecycle enforced by the API (see ALLOWED_TRANSITIONS):
//   requested -> accepted | rejected | cancelled
//   accepted  -> in-progress
//   in-progress -> completed (finalAmount required)
//
// Legacy documents created before this lifecycle (status "pending" /
// "declined") are normalized to "requested" / "rejected" on read and during
// transition checks so old records keep working with the new workflow.
export const BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  "completed",
  "rejected",
  "cancelled",
];

export const PAYMENT_STATUSES = ["unpaid", "paid"];

// Statuses that block a customer from booking the same service again.
export const ACTIVE_BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  // Legacy status kept so pre-existing rows still count as active.
  "pending",
];

// Which role may move a booking from one status to another.
// Admin intentionally has no transition entry: administrators must not gain
// technician booking actions, and completed bookings cannot be edited.
const ALLOWED_TRANSITIONS = {
  requested: {
    accepted: ["technician"],
    rejected: ["technician"],
    cancelled: ["customer"],
  },
  accepted: {
    "in-progress": ["technician"],
  },
  "in-progress": {
    completed: ["technician"],
  },
};

const LEGACY_STATUS_ALIASES = {
  pending: "requested",
  declined: "rejected",
};

export function normalizeStatus(value) {
  if (typeof value !== "string") return null;
  if (BOOKING_STATUSES.includes(value)) return value;
  return LEGACY_STATUS_ALIASES[value] ?? null;
}

export function isValidStatus(value) {
  return normalizeStatus(value) !== null;
}

export function isPaymentStatus(value) {
  return typeof value === "string" && PAYMENT_STATUSES.includes(value);
}

export function canTransition(currentStatus, nextStatus, role) {
  const current = normalizeStatus(currentStatus);
  if (!current || !isValidStatus(nextStatus)) return false;
  const allowedRoles = ALLOWED_TRANSITIONS[current]?.[nextStatus];
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

function pad(value) {
  return String(value).padStart(2, "0");
}

// Accepts "YYYY-MM-DD" (preferred) or any parseable date and returns the
// calendar date as "YYYY-MM-DD", or null when the value is not a real date.
function toCalendarDate(value) {
  const raw = text(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    return raw;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
}

function localTodayCalendarDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Validates the POST /api/bookings request body.
//
// Customer identity (name/email), role, prices and service details are NEVER
// read from the body — they come from the verified session/JWT and MongoDB.
// Returns { error } on failure or { value } with normalized fields.
export function validateBookingInput(body) {
  if (!isRecord(body)) {
    return { error: "A booking object is required." };
  }

  const serviceId = text(body.serviceId);
  const customerPhone = text(body.customerPhone);
  const address = text(body.address);
  const preferredDateRaw = text(body.preferredDate);
  const problemDescription = text(body.problemDescription);

  if (!serviceId || serviceId.length > 100) {
    return { error: "A valid service is required." };
  }

  const phoneDigits = customerPhone.replace(/\D/g, "");
  if (
    !customerPhone ||
    customerPhone.length > 20 ||
    !/^\+?[\d\s\-().]+$/.test(customerPhone) ||
    phoneDigits.length < 7
  ) {
    return { error: "A valid phone number is required." };
  }

  if (address.length < 5 || address.length > 300) {
    return { error: "Address must be between 5 and 300 characters." };
  }

  const preferredDate = toCalendarDate(preferredDateRaw);
  if (!preferredDate) {
    return { error: "Provide a valid preferred date." };
  }
  // Calendar-date comparison keeps "today" valid regardless of time of day.
  if (preferredDate < localTodayCalendarDate()) {
    return { error: "The preferred date must be today or a future date." };
  }

  if (problemDescription.length < 20) {
    return { error: "Problem description must be at least 20 characters." };
  }
  if (problemDescription.length > 2000) {
    return { error: "Problem description must be 2000 characters or fewer." };
  }

  return {
    value: { serviceId, customerPhone, address, preferredDate, problemDescription },
  };
}

// Resolves a service by its public id or _id. Only approved, bookable
// services are returned. The collection stores two historical field shapes
// (status/available and approvalStatus/isAvailable); both are accepted.
export async function findBookableService(serviceId) {
  const lookup = [{ id: serviceId }];
  if (ObjectId.isValid(serviceId)) {
    lookup.push({ _id: new ObjectId(serviceId) });
  }

  return getDatabase()
    .collection("services")
    .findOne({
      $or: lookup,
      $and: [
        { $or: [{ status: "approved" }, { approvalStatus: "approved" }] },
        { $or: [{ available: true }, { isAvailable: true }] },
      ],
    });
}

export async function findBookingById(bookingId) {
  const lookup = [{ id: bookingId }];
  if (ObjectId.isValid(bookingId)) {
    lookup.push({ _id: new ObjectId(bookingId) });
  }

  return bookingsCollection().findOne({ $or: lookup });
}

// One customer may only hold a single active booking per service.
export async function hasActiveBookingForService(serviceId, identity) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    $or: identity,
  });
  return Boolean(booking);
}

// Blocks deleting a service that still has active bookings.
export async function hasActiveBookingsForService(serviceId) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
  });
  return Boolean(booking);
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeDateOnly(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const iso = isoDate(value);
  return iso ? iso.slice(0, 10) : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Serializes a booking document for the frontend. IDs are returned as
// strings; both the assignment field name (`_id`) and the project's
// existing `id` field are provided.
export function serializeBooking(record) {
  const id = record.id || (record._id ? String(record._id) : "");
  const status = normalizeStatus(record.status) ?? "requested";
  const paymentStatus = isPaymentStatus(record.paymentStatus)
    ? record.paymentStatus
    : "unpaid";

  return {
    id,
    _id: id,
    serviceId: record.serviceId ?? null,
    serviceTitle: record.serviceTitle ?? "Service",
    serviceImage: record.serviceImage ?? "",
    category: record.category ?? record.serviceCategory ?? null,
    basePrice: numberOrNull(record.basePrice ?? record.price),
    technicianName: record.technicianName ?? "Technician",
    technicianEmail: record.technicianEmail ?? "",
    customerName: record.customerName ?? "",
    customerEmail: record.customerEmail ?? "",
    customerPhone: record.customerPhone ?? "",
    address: record.address ?? "",
    // Legacy rows stored a full timestamp in `scheduledFor`.
    preferredDate: serializeDateOnly(record.preferredDate ?? record.scheduledFor),
    problemDescription: record.problemDescription ?? record.notes ?? null,
    status,
    finalAmount: numberOrNull(record.finalAmount),
    paymentStatus,
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  };
}

// Creates the indexes used by booking ownership lookups, duplicate checks
// and list queries. Safe to run repeatedly (createIndex is idempotent).
export async function ensureBookingIndexes() {
  const collection = bookingsCollection();
  await Promise.all([
    collection.createIndex({ customerEmail: 1, serviceId: 1, status: 1 }),
    collection.createIndex({ technicianEmail: 1, status: 1 }),
    collection.createIndex({ serviceId: 1, status: 1 }),
    collection.createIndex({ createdAt: -1 }),
  ]);
}
