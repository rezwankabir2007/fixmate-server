import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
import { hasActiveBookingsForService } from "../models/booking.model.js";
import { sendError } from "../utils/response.js";

export const serviceCategories = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];

function toRepairService(record) {
  const publishedAt =
    record.publishedAt instanceof Date
      ? record.publishedAt.toISOString()
      : new Date(record.publishedAt || Date.now()).toISOString();

  return {
    id: record.id || record._id.toHexString(),
    title: record.title || "Untitled Service",
    category: record.category || "General",
    shortDescription: record.shortDescription || record.description || "",
    description: record.description || "",
    price: record.price || record.basePrice || 0,
    duration: record.duration || record.estimatedDuration || "1-2 hours",
    status: record.status || record.approvalStatus || "approved",
    available: record.available ?? record.isAvailable ?? true,
    publishedAt,
    image: record.image || "",
    ...(record.serviceMode ? { serviceMode: record.serviceMode } : {}),
    ...(record.serviceArea ? { serviceArea: record.serviceArea } : {}),
    ...(record.technicianName ? { technicianName: record.technicianName } : {}),
    ...(record.technicianEmail ? { technicianEmail: record.technicianEmail } : {}),
  };
}

export async function listPublicServices(req, res) {
  try {
    const collection = getDatabase().collection("services");
    
    // ডাটাবেজ থেকে সব সার্ভিস ফেচ করা হচ্ছে (কোনো ক্র্যাশিং ফিল্টার ছাড়া)
    const records = await collection.find({}).limit(20).toArray();

    return res.status(200).json({
      data: records.map(toRepairService),
      pagination: {
        page: 1,
        limit: 20,
        total: records.length,
        totalPages: 1,
      },
      filters: { serviceModes: [] },
    });
  } catch (error) {
    console.error("Failed to query public services:", error);
    return res.status(500).json({ error: error.message });
  }
}

// Public detail endpoint: only approved and available services are exposed
// (matching the documented publication contract in SERVICES_API.md). The
// technician profile photo/bio are joined from the user collection when
// available; nothing is hardcoded by the client.
export async function getPublicServiceById(req, res) {
  try {
    const lookup = [{ id: req.params.id }];
    if (ObjectId.isValid(req.params.id)) {
      lookup.push({ _id: new ObjectId(req.params.id) });
    }

    const record = await getDatabase().collection("services").findOne({
      $or: lookup,
      $and: [
        { $or: [{ status: "approved" }, { approvalStatus: "approved" }] },
        { $or: [{ available: true }, { isAvailable: true }] },
      ],
    });
    if (!record) return sendError(res, "Service not found.", 404);

    const data = toRepairService(record);

    const technicianId =
      typeof record.technicianId === "string" ? record.technicianId : "";
    const technicianEmail =
      typeof record.technicianEmail === "string" ? record.technicianEmail : "";

    if (technicianId || technicianEmail) {
      const userLookup = [];
      if (technicianId) {
        userLookup.push({ id: technicianId });
        if (ObjectId.isValid(technicianId)) {
          userLookup.push({ _id: new ObjectId(technicianId) });
        }
      }
      if (technicianEmail) {
        userLookup.push({ email: technicianEmail });
      }

      const technician = await getDatabase()
        .collection("user")
        .findOne(
          { $or: userLookup },
          { projection: { name: 1, image: 1, bio: 1, area: 1, serviceArea: 1 } },
        );

      if (technician) {
        if (!data.technicianName && technician.name) {
          data.technicianName = technician.name;
        }
        if (technician.image) {
          data.technicianImage = technician.image;
        }
        if (typeof technician.bio === "string" && technician.bio.trim()) {
          data.technicianBio = technician.bio.trim();
        }
        const technicianArea =
          (typeof technician.area === "string" && technician.area.trim()) ||
          (typeof technician.serviceArea === "string" &&
            technician.serviceArea.trim()) ||
          "";
        if (technicianArea) {
          data.technicianArea = technicianArea;
        }
      }
    }

    return res.status(200).json({ data });
  } catch (error) {
    console.error(`Failed to load public service "${req.params.id}".`, error);
    return sendError(res, "Service details are temporarily unavailable.", 500);
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createTechnicianService(req, res) {
  const body = req.body;
  if (!isRecord(body)) return sendError(res, "A service object is required.", 400);

  const title = text(body.title);
  const category = text(body.category);
  const shortDescription = text(body.shortDescription);
  const description = text(body.description);
  const duration = text(body.duration);
  const image = text(body.image);
  const serviceMode = text(body.serviceMode);
  const price =
    typeof body.price === "string" || typeof body.price === "number"
      ? Number(body.price)
      : Number.NaN;

  if (title.length < 2 || title.length > 100) {
    return sendError(res, "Title must be between 2 and 100 characters.", 400);
  }
  if (!serviceCategories.includes(category)) {
    return sendError(res, "Choose a valid service category.", 400);
  }
  if (shortDescription.length < 10 || shortDescription.length > 200) {
    return sendError(res, "Short description must be between 10 and 200 characters.", 400);
  }
  if (description.length < 10 || description.length > 3000) {
    return sendError(res, "Description must be between 10 and 3000 characters.", 400);
  }
  if (!Number.isFinite(price) || price <= 0) {
    return sendError(res, "Price must be a positive number.", 400);
  }
  if (duration.length < 2 || duration.length > 80) {
    return sendError(res, "Duration must be between 2 and 80 characters.", 400);
  }
  if (serviceMode.length > 60) {
    return sendError(res, "Service mode must be 60 characters or fewer.", 400);
  }

  let imageUrl;
  try {
    imageUrl = new URL(image);
  } catch {
    return sendError(res, "Provide a valid image URL.", 400);
  }
  if (!["http:", "https:"].includes(imageUrl.protocol) || image.length > 2048) {
    return sendError(res, "Image URL must use HTTP or HTTPS and be under 2048 characters.", 400);
  }

  try {
    const id = new ObjectId().toHexString();
    await getDatabase().collection("services").insertOne({
      id,
      title,
      category,
      shortDescription,
      description,
      price,
      duration,
      image: imageUrl.toString(),
      ...(serviceMode ? { serviceMode } : {}),
      technicianId: req.authUser.id,
      // Server-derived technician identity (never client-supplied) so the
      // booking flow can snapshot the assigned technician reliably.
      technicianName: req.authUser.name || "",
      technicianEmail: req.authUser.email || "",
      status: "pending",
      available: false,
      publishedAt: new Date(),
    });
    return res.status(201).json({ data: { id, status: "pending" } });
  } catch (error) {
    console.error("Failed to create technician service.", error);
    return sendError(res, "Service submission is temporarily unavailable.", 500);
  }
}

export async function deleteTechnicianService(req, res) {
  try {
    const lookup = [{ id: req.params.id }];
    if (ObjectId.isValid(req.params.id)) {
      lookup.push({ _id: new ObjectId(req.params.id) });
    }

    const service = await getDatabase()
      .collection("services")
      .findOne({ technicianId: req.authUser.id, $or: lookup });
    if (!service) return sendError(res, "Service not found.", 404);

    const serviceId = service.id || String(service._id);
    if (await hasActiveBookingsForService(serviceId)) {
      return sendError(
        res,
        "This service has active bookings and cannot be deleted.",
        409,
      );
    }

    const result = await getDatabase()
      .collection("services")
      .deleteOne({ _id: service._id });
    if (result.deletedCount === 0) {
      return sendError(res, "Service not found.", 404);
    }

    return res.status(200).json({ data: { id: serviceId, deleted: true } });
  } catch (error) {
    console.error(`Failed to delete service "${req.params.id}".`, error);
    return sendError(res, "The service could not be deleted.", 500);
  }
}