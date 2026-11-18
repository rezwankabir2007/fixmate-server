import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";

// GET /api/admin/accounts — read-only account directory.
export async function listAccounts(req, res) {
  try {
    const records = await getDatabase()
      .collection("user")
      .find({}, { projection: { name: 1, email: 1, role: 1, createdAt: 1 } })
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

export async function moderateService(req, res) {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("status" in body)) {
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
    const result = await getDatabase().collection("services").updateOne(
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
      return sendError(res, "Pending service not found or already reviewed.", 404);
    }
    return res.status(200).json({
      data: { id: req.params.id, status, available: status === "approved" },
    });
  } catch (error) {
    console.error(`Failed to moderate service "${req.params.id}".`, error);
    return sendError(res, "Service moderation is temporarily unavailable.", 500);
  }
}
