
import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";

// Booking status lifecycle.
export const BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  "completed",
  "rejected",
  "cancelled",
];

export const PAYMENT_STATUSES = ["unpaid", "paid"];

// Statuses that prevent duplicate active bookings.
export const ACTIVE_BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  "pending",
];

// Allowed status transitions by role.
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

// Support for legacy booking statuses.
const LEGACY_STATUS_ALIASES = {
  pending: "requested",
  declined: "rejected",
};

export function normalizeStatus(value) {
  if (typeof value !== "string") return null;

  if (BOOKING_STATUSES.includes(value)) {
    return value;
  }

  return LEGACY_STATUS_ALIASES[value] ?? null;
}

export function isValidStatus(value) {
  return normalizeStatus(value) !== null;
}

export function isPaymentStatus(value) {
  return (
    typeof value === "string" &&
    PAYMENT_STATUSES.includes(value)
  );
}

export function canTransition(currentStatus, nextStatus, role) {
  const current = normalizeStatus(currentStatus);

  if (!current || !isValidStatus(nextStatus)) {
    return false;
  }

  const allowedRoles = ALLOWED_TRANSITIONS[current]?.[nextStatus];

  return (
    Array.isArray(allowedRoles) &&
    allowedRoles.includes(role)
  );
}

export function bookingsCollection() {
  return getDatabase().collection("bookings");
}

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

// Converts a date into YYYY-MM-DD.
function toCalendarDate(value) {
  const raw = text(value);

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);

    const probe = new Date(
      Date.UTC(year, month - 1, day)
    );

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

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return `${parsed.getUTCFullYear()}-${pad(
    parsed.getUTCMonth() + 1
  )}-${pad(parsed.getUTCDate())}`;
}

function localTodayCalendarDate() {
  const now = new Date();

  return `${now.getFullYear()}-${pad(
    now.getMonth() + 1
  )}-${pad(now.getDate())}`;
}

// Validates customer booking input.
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
    return {
      error: "Address must be between 5 and 300 characters.",
    };
  }

  const preferredDate = toCalendarDate(preferredDateRaw);

  if (!preferredDate) {
    return { error: "Provide a valid preferred date." };
  }

  if (preferredDate < localTodayCalendarDate()) {
    return {
      error: "The preferred date must be today or a future date.",
    };
  }

  if (problemDescription.length < 20) {
    return {
      error: "Problem description must be at least 20 characters.",
    };
  }

  if (problemDescription.length > 2000) {
    return {
      error: "Problem description must be 2000 characters or fewer.",
    };
  }

  return {
    value: {
      serviceId,
      customerPhone,
      address,
      preferredDate,
      problemDescription,
    },
  };
}

// Finds an approved and available service.
export async function findBookableService(serviceId) {
  const lookup = [{ id: serviceId }];

  if (ObjectId.isValid(serviceId)) {
    lookup.push({
      _id: new ObjectId(serviceId),
    });
  }

  return getDatabase()
    .collection("services")
    .findOne({
      $or: lookup,
      $and: [
        {
          $or: [
            { status: "approved" },
            { approvalStatus: "approved" },
          ],
        },
        {
          $or: [
            { available: true },
            { isAvailable: true },
          ],
        },
      ],
    });
}

// Finds a booking using its public ID or MongoDB ObjectId.
export async function findBookingById(bookingId) {
  if (
    typeof bookingId !== "string" ||
    !bookingId.trim()
  ) {
    return null;
  }

  const id = bookingId.trim();
  const lookup = [{ id }];

  if (ObjectId.isValid(id)) {
    lookup.push({
      _id: new ObjectId(id),
    });
  }

  return bookingsCollection().findOne({
    $or: lookup,
  });
}

// Checks whether a customer already has an active booking.
export async function hasActiveBookingForService(
  serviceId,
  identity
) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    status: {
      $in: ACTIVE_BOOKING_STATUSES,
    },
    $or: identity,
  });

  return Boolean(booking);
}

// Prevents deleting services with active bookings.
export async function hasActiveBookingsForService(serviceId) {
  const booking = await bookingsCollection().findOne({
    serviceId,
    status: {
      $in: ACTIVE_BOOKING_STATUSES,
    },
  });

  return Boolean(booking);
}

function isoDate(value) {
  if (!value) return null;

  const date = value instanceof Date
    ? value
    : new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function serializeDateOnly(value) {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return value;
  }

  const iso = isoDate(value);

  return iso ? iso.slice(0, 10) : null;
}

function numberOrNull(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  )
    ? value
    : null;
}

// Converts MongoDB booking documents into frontend-safe data.
export function serializeBooking(record) {
  const id = record.id || (
    record._id ? String(record._id) : ""
  );

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
    basePrice: numberOrNull(
      record.basePrice ?? record.price
    ),
    technicianName: record.technicianName ?? "Technician",
    technicianEmail: record.technicianEmail ?? "",
    customerName: record.customerName ?? "",
    customerEmail: record.customerEmail ?? "",
    customerPhone: record.customerPhone ?? "",
    address: record.address ?? "",
    preferredDate: serializeDateOnly(
      record.preferredDate ?? record.scheduledFor
    ),
    problemDescription:
      record.problemDescription ?? record.notes ?? null,
    status,
    finalAmount: numberOrNull(record.finalAmount),
    paymentStatus,
    createdAt: isoDate(record.createdAt),
    updatedAt: isoDate(record.updatedAt),
  };
}

// Creates indexes required by booking queries.
export async function ensureBookingIndexes() {
  const collection = bookingsCollection();

  await Promise.all([
    collection.createIndex({
      customerEmail: 1,
      serviceId: 1,
      status: 1,
    }),
    collection.createIndex({
      technicianEmail: 1,
      status: 1,
    }),
    collection.createIndex({
      serviceId: 1,
      status: 1,
    }),
    collection.createIndex({
      createdAt: -1,
    }),
  ]);
}
