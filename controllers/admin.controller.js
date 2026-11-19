
import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";

// GET /api/admin/accounts
// Admin can view all user accounts.
export async function listAccounts(req, res) {
  try {
    const records = await getDatabase()
      .collection("user")
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            createdAt: 1,
          },
        },
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(200)
      .toArray();

    return res.status(200).json({
      data: records.map((record) => ({
        id: record.id || String(record._id),
        name: record.name ?? "",
        email: record.email ?? "",
        role: record.role ?? "customer",
        createdAt:
          record.createdAt instanceof Date
            ? record.createdAt.toISOString()
            : record.createdAt ?? null,
      })),
      total: records.length,
    });
  } catch (error) {
    console.error("Failed to list accounts.", error);
    return sendError(res, "Account records could not be loaded.", 500);
  }
}

// PATCH /api/admin/services/:id
// Admin can approve or reject pending services.
export async function moderateService(req, res) {
  const body = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("status" in body)
  ) {
    return sendError(res, "A moderation status is required.", 400);
  }

  const status = body.status;

  if (status !== "approved" && status !== "rejected") {
    return sendError(res, "Status must be approved or rejected.", 400);
  }

  try {
    const lookup = [{ id: req.params.id }];

    if (ObjectId.isValid(req.params.id)) {
      lookup.push({ _id: new ObjectId(req.params.id) });
    }

    const result = await getDatabase()
      .collection("services")
      .updateOne(
        { status: "pending", $or: lookup },
        {
          $set: {
            status,
            available: status === "approved",
            moderatedAt: new Date(),
            moderatedBy: req.authUser.id,
          },
        },
      );

    if (result.matchedCount === 0) {
      return sendError(
        res,
        "Pending service not found or already reviewed.",
        404,
      );
    }

    return res.status(200).json({
      data: {
        id: req.params.id,
        status,
        available: status === "approved",
      },
    });
  } catch (error) {
    console.error(`Failed to moderate service "${req.params.id}".`, error);
    return sendError(
      res,
      "Service moderation is temporarily unavailable.",
      500,
    );
  }
}

// PATCH /api/admin/accounts/:id/role
// Admin can change customer <-> technician roles only.
export async function updateAccountRole(req, res) {
  const { id } = req.params;
  const { role } = req.body ?? {};

  if (!["customer", "technician"].includes(role)) {
    return sendError(
      res,
      "Role must be either customer or technician.",
      400,
    );
  }

  if (!id || typeof id !== "string") {
    return sendError(res, "Invalid account ID.", 400);
  }

  if (id === req.authUser.id) {
    return sendError(res, "You cannot change your own role.", 403);
  }

  try {
    const lookup = [{ id }];

    if (ObjectId.isValid(id)) {
      lookup.push({ _id: new ObjectId(id) });
    }

    const users = getDatabase().collection("user");

    const target = await users.findOne({ $or: lookup });

    if (!target) {
      return sendError(res, "User account not found.", 404);
    }

    if ((target.role ?? "customer") === "admin") {
      return sendError(res, "Admin accounts cannot be changed here.", 403);
    }

    const result = await users.updateOne(
      { _id: target._id, role: { $ne: "admin" } },
      {
        $set: {
          role,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return sendError(res, "Account role could not be updated.", 409);
    }

    // Invalidate existing sessions so the user must sign in again.
    const sessionLookup = [{ userId: String(target._id) }];

    if (ObjectId.isValid(String(target._id))) {
      sessionLookup.push({
        userId: new ObjectId(String(target._id)),
      });
    }

    await getDatabase()
      .collection("session")
      .deleteMany({ $or: sessionLookup });

    return res.status(200).json({
      message: "Account role updated successfully. The user must sign in again.",
      data: {
        id: String(target._id),
        name: target.name ?? "",
        email: target.email ?? "",
        role,
      },
    });
  } catch (error) {
    console.error("Failed to update account role.", error);
    return sendError(res, "Account role could not be updated.", 500);
  }
}
