const ALLOWED_MIME_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const UPLOAD_PURPOSES = Object.freeze({
  CONTENT: "content",
  BRAND_LOGO: "brand_logo",
  AVATAR: "avatar",
});

const MEDIA_STATUS = Object.freeze({
  PENDING: "pending",
  READY: "ready",
  FAILED: "failed",
});

module.exports = {
  ALLOWED_MIME_TYPES,
  UPLOAD_PURPOSES,
  MEDIA_STATUS,
};
