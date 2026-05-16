const mongoose = require("mongoose");

const adminNotificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        "email_blast",
        "admin_grant",
        "user_suspended",
        "user_unsuspended",
        "subscription_updated",
        "schedule_retried",
      ],
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, default: "", trim: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, default: null },
    audience: { type: String, default: "" },
    recipientCount: { type: Number, default: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

adminNotificationSchema.index({ createdAt: -1 });

const AdminNotification = mongoose.model("AdminNotification", adminNotificationSchema);

module.exports = AdminNotification;
