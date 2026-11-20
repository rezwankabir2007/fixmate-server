import multer from "multer";
import { sendError } from "../utils/response.js";

// Multipart upload middleware for pre-signup profile images.
export const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

const ALLOWED_PROFILE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PROFILE_IMAGE_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_PROFILE_IMAGE_TYPES.has(file.mimetype)) {
      const error = new Error("Unsupported image type.");
      error.status = 415;
      return cb(error);
    }
    cb(null, true);
  },
}).single("image");

// Runs the multer parser and converts multer errors into safe JSON responses.
export function parseProfileImageUpload(req, res, next) {
  profileImageUpload(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return sendError(res, "Image must be 2MB or smaller.", 413);
      }
      if (error.code === "LIMIT_UNEXPECTED_FILE") {
        return sendError(
          res,
          'Send the image in a form field named "image".',
          400,
        );
      }
      return sendError(res, "The uploaded image could not be processed.", 400);
    }

    if (error.status) {
      return sendError(res, error.message, error.status);
    }

    console.error("Profile image parsing failed.", error);
    return sendError(res, "The uploaded image could not be processed.", 400);
  });
}
