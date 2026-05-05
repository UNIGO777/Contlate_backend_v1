const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { ALLOWED_MIME_TYPES, MEDIA_STATUS, UPLOAD_PURPOSES } = require("../../constants/upload");
const { PLAN_LIMITS } = require("../../constants/limits");
const storage = require("../../services/storage.service");
const MediaAsset = require("./mediaAsset.model");
const User = require("../user/user.model");
const Business = require("../business/business.model");
const usageService = require("../usage/usage.service");

const sanitize = (m) => ({
  id: m._id.toString(),
  provider: m.provider,
  storageKey: m.storageKey,
  publicUrl: m.publicUrl,
  mimeType: m.mimeType,
  sizeBytes: m.sizeBytes,
  width: m.width,
  height: m.height,
  purpose: m.purpose,
  status: m.status,
  originalFileName: m.originalFileName,
  createdAt: m.createdAt,
  confirmedAt: m.confirmedAt,
});

const getMaxBytesForUser = async (userId) => {
  const user = await User.findById(userId).select("plan");
  const plan = user?.plan || "basic";
  return PLAN_LIMITS[plan]?.maxUploadBytes || 5 * 1024 * 1024;
};

const prepare = async (userId, { fileName, mimeType, purpose, folder }) => {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new ApiError(400, "Unsupported file type.", {
      code: ERROR_CODES.UPLOAD_INVALID_MIME,
      details: { allowed: ALLOWED_MIME_TYPES },
    });
  }

  const maxSizeBytes = await getMaxBytesForUser(userId);
  const business = await Business.findOne({ userId }).select("_id");

  const target = await storage.getPresignedUpload({
    userId,
    folder: folder || purpose || UPLOAD_PURPOSES.CONTENT,
    fileName,
    mimeType,
    maxSizeBytes,
  });

  const asset = await MediaAsset.create({
    userId,
    businessId: business?._id || null,
    provider: target.provider,
    storageKey: target.storageKey,
    publicUrl: target.publicUrl,
    mimeType,
    originalFileName: fileName,
    purpose: purpose || UPLOAD_PURPOSES.CONTENT,
    status: MEDIA_STATUS.PENDING,
  });

  return {
    mediaAssetId: asset._id.toString(),
    upload: {
      provider: target.provider,
      uploadUrl: target.uploadUrl,
      method: target.method,
      headers: target.headers,
      storageKey: target.storageKey,
      publicUrl: target.publicUrl,
      expiresAt: target.expiresAt,
      maxSizeBytes,
    },
  };
};

const confirm = async (userId, { mediaAssetId }) => {
  const asset = await MediaAsset.findOne({ _id: mediaAssetId, userId, deletedAt: null });
  if (!asset) {
    throw new ApiError(404, "Upload record not found.", { code: ERROR_CODES.UPLOAD_NOT_FOUND });
  }

  if (asset.status === MEDIA_STATUS.READY) {
    return { asset: sanitize(asset), usage: null };
  }

  const head = await storage.head(asset.storageKey);
  if (!head?.exists) {
    throw new ApiError(400, "Upload was not found in storage.", {
      code: ERROR_CODES.UPLOAD_NOT_FOUND,
    });
  }

  const maxSizeBytes = await getMaxBytesForUser(userId);
  if (head.sizeBytes > maxSizeBytes) {
    await storage.remove(asset.storageKey).catch(() => {});
    asset.status = MEDIA_STATUS.FAILED;
    await asset.save();
    throw new ApiError(413, "Uploaded file exceeds maximum allowed size.", {
      code: ERROR_CODES.UPLOAD_TOO_LARGE,
    });
  }

  await usageService.assertUsageWithinLimit(userId, "uploadsCount");
  const usage = await usageService.incrementUsage(userId, "uploadsCount");

  asset.sizeBytes = head.sizeBytes;
  asset.status = MEDIA_STATUS.READY;
  asset.confirmedAt = new Date();
  await asset.save();

  return { asset: sanitize(asset), usage };
};

const list = async (userId, { page = 1, limit = 20, purpose } = {}) => {
  const q = { userId, deletedAt: null };
  if (purpose) q.purpose = purpose;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    MediaAsset.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit),
    MediaAsset.countDocuments(q),
  ]);
  return { data: rows.map(sanitize), page, limit, total };
};

const remove = async (userId, mediaAssetId) => {
  const asset = await MediaAsset.findOne({ _id: mediaAssetId, userId, deletedAt: null });
  if (!asset) {
    throw new ApiError(404, "Upload record not found.", { code: ERROR_CODES.UPLOAD_NOT_FOUND });
  }
  await storage.remove(asset.storageKey).catch(() => {});
  asset.deletedAt = new Date();
  await asset.save();
  return { deleted: true };
};

module.exports = { prepare, confirm, list, remove, sanitize };
