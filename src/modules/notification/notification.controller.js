const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const Notification = require("./notification.model");

const getNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const skip = (page - 1) * limit;

  const filter = { userId: req.user.id };
  if (req.query.unreadOnly === "true") {
    filter.read = false;
  }

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);

  const unreadCount = await Notification.countDocuments({ userId: req.user.id, read: false });

  return res.status(200).json(
    new ApiResponse(200, { notifications, total, page, limit, unreadCount }, "Notifications fetched.")
  );
});

const markRead = asyncHandler(async (req, res) => {
  const { notificationId, all } = req.body;

  if (all) {
    await Notification.updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true } }
    );
  } else if (notificationId) {
    await Notification.updateOne(
      { _id: notificationId, userId: req.user.id },
      { $set: { read: true } }
    );
  }

  return res.status(200).json(new ApiResponse(200, null, "Notifications marked as read."));
});

module.exports = { getNotifications, markRead };
