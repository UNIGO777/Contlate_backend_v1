const SCHEDULE_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  PUBLISHED: "published",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PAUSED: "paused",
});

module.exports = {
  SCHEDULE_STATUS,
};
