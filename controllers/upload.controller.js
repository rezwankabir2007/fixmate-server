import { sendError } from "../utils/response.js";
import { uploadImageBuffer } from "../config/cloudinary.js";
import { MAX_PROFILE_IMAGE_BYTES } from "../middleware/upload.middleware.js";

// POST /api/upload/profile-image
// Accepts multipart/form-data with a single "image" file and uploads it to
// Cloudinary through a server-side signed upload. No login is required so
// users can attach a photo before signing up.
export async function uploadProfileImage(req, res) {
  const file = req.file;

  if (!file || !file.buffer || file.buffer.length === 0) {
    return sendError(res, "Please select an image to upload.", 400);
  }

  if (file.size > MAX_PROFILE_IMAGE_BYTES) {
    return sendError(res, "Image must be 2MB or smaller.", 413);
  }

  try {
    const result = await uploadImageBuffer(file.buffer);

    return res.status(200).json({
      success: true,
      secure_url: result.secure_url,
    });
  } catch (error) {
    // Log only a short reason. Credentials are never logged or returned.
    const reason =
      error?.http_code ?? error?.message ?? "unknown upload failure";
    console.error("Profile image upload failed:", reason);
    return sendError(
      res,
      "We couldn't upload your profile image right now. Please try again.",
      502,
    );
  }
}
