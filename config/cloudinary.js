import { v2 as cloudinary } from "cloudinary";

// Reusable Cloudinary configuration.
// Credentials are read from process.env only and are never exposed to the client.
const CLOUDINARY_FOLDER = "fixmate/profiles";

function getCloudinaryCredentials() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary environment variables are not configured.");
  }

  return { cloudName, apiKey, apiSecret };
}

function configureCloudinary() {
  const { cloudName, apiKey, apiSecret } = getCloudinaryCredentials();
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

// Uploads an in-memory image buffer through Cloudinary's server-side signed upload.
export function uploadImageBuffer(buffer, { folder = CLOUDINARY_FOLDER } = {}) {
  configureCloudinary();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.secure_url) {
          return reject(new Error("Cloudinary did not return a secure URL."));
        }
        resolve(result);
      },
    );

    stream.on("error", reject);
    stream.end(buffer);
  });
}
