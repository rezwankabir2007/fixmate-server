import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
import { sendError } from "../utils/response.js";

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
