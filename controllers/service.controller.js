import { ObjectId } from "mongodb";
import { getDatabase } from "../config/db.js";
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

const publicServiceFilter = {
  status: "approved",
  available: true,
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRepairService(record) {
  const publishedAt =
    record.publishedAt instanceof Date
      ? record.publishedAt.toISOString()
      : new Date(record.publishedAt).toISOString();

  return {
    id: record.id || record._id.toHexString(),
    title: record.title,
    category: record.category,
    shortDescription: record.shortDescription,
    description: record.description,
    price: record.price,
    duration: record.duration,
    status: "approved",
    available: true,
    publishedAt,
    image: record.image,
    ...(record.serviceMode ? { serviceMode: record.serviceMode } : {}),
  };
}

function parseServiceListParams(searchParams) {
  const single = (key) => {
    const values = searchParams.getAll(key);
    return values.length > 1 ? null : values[0]?.trim() ?? "";
  };

  const q = single("q");
  const category = single("category");
  const serviceMode = single("serviceMode");
  const sort = single("sort") || "newest";
  const pageValue = single("page") || "1";
  const limitValue = single("limit") || "6";

  if (
    q === null ||
    category === null ||
    serviceMode === null ||
    sort === null ||
    pageValue === null ||
    limitValue === null
  ) {
    return { error: "Each query parameter may only be provided once." };
  }
  if (q.length > 100) return { error: "Search text must be 100 characters or fewer." };
  if (category && !serviceCategories.includes(category)) {
    return { error: "Choose a valid service category." };
  }
  if (!["newest", "price-asc", "price-desc"].includes(sort)) {
    return { error: "Sort must be newest, price-asc, or price-desc." };
  }
  if (serviceMode.length > 60) return { error: "Service mode must be 60 characters or fewer." };

  const page = Number(pageValue);
  const limit = Number(limitValue);
  if (!Number.isInteger(page) || page < 1) return { error: "Page must be a positive integer." };
  if (!Number.isInteger(limit) || limit < 1 || limit > 24) {
    return { error: "Limit must be an integer between 1 and 24." };
  }

  return {
    params: {
      q,
      category,
      serviceMode,
      sort,
      page,
      limit,
    },
  };
}

function serviceSort(sort) {
  if (sort === "price-asc") return { price: 1, _id: 1 };
  if (sort === "price-desc") return { price: -1, _id: -1 };
  return { publishedAt: -1, _id: -1 };
}

function createServiceFilter(params) {
  const filter = { ...publicServiceFilter };

  if (params.category) filter.category = params.category;
  if (params.serviceMode) filter.serviceMode = params.serviceMode;
  if (params.q) {
    const search = new RegExp(escapeRegex(params.q), "i");
    filter.$or = [{ title: search }, { category: search }];
  }

  return filter;
}

export async function listPublicServices(req, res) {
  const searchParams = new URL(req.originalUrl, "http://localhost").searchParams;
  const parsed = parseServiceListParams(searchParams);
  if ("error" in parsed) return sendError(res, parsed.error, 400);

  try {
    const collection = getDatabase().collection("services");
    const filter = createServiceFilter(parsed.params);
    const [records, total, rawServiceModes] = await Promise.all([
      collection
        .find(filter)
        .sort(serviceSort(parsed.params.sort))
        .skip((parsed.params.page - 1) * parsed.params.limit)
        .limit(parsed.params.limit)
        .toArray(),
      collection.countDocuments(filter),
      collection.distinct("serviceMode", publicServiceFilter),
    ]);
    const serviceModes = rawServiceModes
      .filter((mode) => typeof mode === "string" && mode.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));

    return res.status(200).json({
      data: records.map(toRepairService),
      pagination: {
        page: parsed.params.page,
        limit: parsed.params.limit,
        total,
        totalPages: Math.ceil(total / parsed.params.limit),
      },
      filters: { serviceModes },
    });
  } catch (error) {
    console.error("Failed to query public services.", error);
    return sendError(res, "Service catalog is temporarily unavailable.", 500);
  }
}

export async function getPublicServiceById(req, res) {
  try {
    const lookup = [{ id: req.params.id }];
    if (ObjectId.isValid(req.params.id)) {
      lookup.push({ _id: new ObjectId(req.params.id) });
    }

    const record = await getDatabase().collection("services").findOne({
      ...publicServiceFilter,
      $or: lookup,
    });
    if (!record) return sendError(res, "Service not found.", 404);
    return res.status(200).json({ data: toRepairService(record) });
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
