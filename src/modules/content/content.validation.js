const { CONTENT_STATUS } = require("../../constants/contentStatus");
const { isNonEmptyString } = require("../../validators/common.validator");

const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .filter((tag) => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
};

const validateContentPayload = (req) => {
  const { imageUrl, caption, status, sourceType, tags } = req.body || {};
  const details = [];

  if (!isNonEmptyString(imageUrl)) {
    details.push("imageUrl is required.");
  }

  if (status && !Object.values(CONTENT_STATUS).includes(status)) {
    details.push("status is invalid.");
  }

  if (sourceType && !isNonEmptyString(sourceType)) {
    details.push("sourceType must be a non-empty string when provided.");
  }

  if (details.length > 0) {
    return {
      error: "Validation failed.",
      details,
    };
  }

  return {
    value: {
      imageUrl: imageUrl?.trim(),
      caption: isNonEmptyString(caption) ? caption.trim() : "",
      status: status || CONTENT_STATUS.READY,
      sourceType: isNonEmptyString(sourceType) ? sourceType.trim() : "manual",
      tags: normalizeTags(tags),
    },
  };
};

const validateContentUpdatePayload = (req) => {
  const { imageUrl, caption, status, sourceType, tags } = req.body || {};
  const details = [];
  const value = {};

  if (imageUrl !== undefined) {
    if (!isNonEmptyString(imageUrl)) {
      details.push("imageUrl must be a non-empty string.");
    } else {
      value.imageUrl = imageUrl.trim();
    }
  }

  if (caption !== undefined) {
    if (typeof caption !== "string") {
      details.push("caption must be a string.");
    } else {
      value.caption = caption.trim();
    }
  }

  if (status !== undefined) {
    if (!Object.values(CONTENT_STATUS).includes(status)) {
      details.push("status is invalid.");
    } else {
      value.status = status;
    }
  }

  if (sourceType !== undefined) {
    if (!isNonEmptyString(sourceType)) {
      details.push("sourceType must be a non-empty string.");
    } else {
      value.sourceType = sourceType.trim();
    }
  }

  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      details.push("tags must be an array.");
    } else {
      value.tags = normalizeTags(tags);
    }
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one field must be provided for update.");
  }

  if (details.length > 0) {
    return {
      error: "Validation failed.",
      details,
    };
  }

  return {
    value,
  };
};

module.exports = {
  validateContentPayload,
  validateContentUpdatePayload,
};
