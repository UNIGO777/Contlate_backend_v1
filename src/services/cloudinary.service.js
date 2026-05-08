const { v2: cloudinary } = require("cloudinary");
const env = require("../config/env");

let configured = false;

const configure = () => {
  if (configured) return;
  if (!env.cloudinary.cloudName || !env.cloudinary.apiKey || !env.cloudinary.apiSecret) {
    return;
  }
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key:    env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  configured = true;
};

configure();

const isConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer  - File buffer
 * @param {object} options - { folder, publicId, resourceType }
 * @returns {Promise<{ publicUrl: string, publicId: string }>}
 */
const uploadBuffer = (buffer, { folder = "logos", publicId, resourceType = "image" } = {}) => {
  if (!isConfigured()) {
    throw new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env");
  }
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      overwrite: true,
    };
    if (publicId) uploadOptions.public_id = publicId;

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve({ publicUrl: result.secure_url, publicId: result.public_id });
    });
    stream.end(buffer);
  });
};

/**
 * Delete a file from Cloudinary by its public ID.
 */
const deleteByPublicId = async (publicId) => {
  if (!isConfigured()) return;
  await cloudinary.uploader.destroy(publicId);
};

module.exports = { isConfigured, uploadBuffer, deleteByPublicId };
