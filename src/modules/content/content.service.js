const mongoose = require("mongoose");
const ApiError = require("../../core/ApiError");
const Content = require("./content.model");

const ensureValidId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, `${label} is invalid.`);
  }
};

const sanitizeContent = (content) => ({
  id: content._id.toString(),
  userId: content.userId.toString(),
  businessId: content.businessId.toString(),
  imageUrl: content.imageUrl,
  caption: content.caption,
  status: content.status,
  sourceType: content.sourceType,
  tags: content.tags,
  createdAt: content.createdAt,
  updatedAt: content.updatedAt,
});

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
