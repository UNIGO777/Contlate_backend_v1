const mongoose = require("mongoose");
const { UPLOAD_PURPOSES, MEDIA_STATUS } = require("../../constants/upload");

const mediaAssetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
      index: true,
    },
    provider: { type: String, required: true },
    storageKey: { type: String, required: true, unique: true },
    publicUrl: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, default: 0, min: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    originalFileName: { type: String, default: null },
    purpose: {
      type: String,
      enum: Object.values(UPLOAD_PURPOSES),
      default: UPLOAD_PURPOSES.CONTENT,
    },
    status: {
      type: String,
      enum: Object.values(MEDIA_STATUS),
      default: MEDIA_STATUS.PENDING,
      index: true,
    },
    confirmedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, versionKey: false }
);

mediaAssetSchema.index({ userId: 1, createdAt: -1 });
mediaAssetSchema.index({ storageKey: 1 }, { unique: true });

const MediaAsset = mongoose.model("MediaAsset", mediaAssetSchema);

module.exports = MediaAsset;
