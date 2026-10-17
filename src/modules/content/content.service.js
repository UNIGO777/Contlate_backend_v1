const mongoose = require("mongoose");
const ApiError = require("../../core/ApiError");
const Content = require("./content.model");

const ensureValidId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, `${label} is invalid.`);
  }
};

// A published poster is deleted from our disk once it is live, so its own
// imageUrl 404s from that moment on. The platform's copy is the only image
// left, and the permalink is the lasting record of where it went.
const sanitizeContent = (content) => {
  const link = (content.socialPostUrls || []).find((u) => u.mediaUrl || u.postUrl) || {};
  const imageUrl = content.localImageDeleted
    ? link.mediaUrl || null
    : content.imageUrl;

  return {
    id: content._id.toString(),
    userId: content.userId.toString(),
    businessId: content.businessId.toString(),
    imageUrl,
    caption: content.caption,
    status: content.status,
    sourceType: content.sourceType,
    tags: content.tags,
    // Where the published post lives, when there is one.
    postUrl: link.postUrl || "",
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
  };
};

const createContent = async ({ userId, businessId, payload }) => {
  const content = await Content.create({
    userId,
    businessId,
    ...payload,
  });

  return sanitizeContent(content);
};

const listContentByUserId = async (userId) => {
  const items = await Content.find({ userId }).sort({ createdAt: -1 });
  return items.map(sanitizeContent);
};

const getContentById = async ({ userId, contentId }) => {
  ensureValidId(contentId, "contentId");

  const content = await Content.findOne({ _id: contentId, userId });

  if (!content) {
    throw new ApiError(404, "Content not found.");
  }

  return sanitizeContent(content);
};

const updateContent = async ({ userId, contentId, payload }) => {
  ensureValidId(contentId, "contentId");

  const content = await Content.findOne({ _id: contentId, userId });

  if (!content) {
    throw new ApiError(404, "Content not found.");
  }

  Object.assign(content, payload);
  await content.save();

  return sanitizeContent(content);
};

const deleteContent = async ({ userId, contentId }) => {
  ensureValidId(contentId, "contentId");

  const content = await Content.findOneAndDelete({ _id: contentId, userId });

  if (!content) {
    throw new ApiError(404, "Content not found.");
  }

  return sanitizeContent(content);
};

module.exports = {
  createContent,
  listContentByUserId,
  getContentById,
  updateContent,
  deleteContent,
};
