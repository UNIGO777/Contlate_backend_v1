const { Expo } = require("expo-server-sdk");
const logger = require("../core/logger");
const User = require("../modules/user/user.model");

const expo = new Expo({ useFcmV1: true });

/**
 * Send an Expo push notification to all registered devices for a user.
 *
 * @param {string|ObjectId} userId
 * @param {{ title: string, body: string, data?: object }} payload
 */
const sendPushNotification = async (userId, { title, body, data = {} }) => {
  const user = await User.findById(userId).select("expoPushTokens").lean();
  if (!user?.expoPushTokens?.length) return;

  const tokens = user.expoPushTokens.map((t) => t.token).filter(Boolean);
  const messages = [];

  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) {
      logger.warn("[push] invalid token, skipping", { token });
      continue;
    }
    messages.push({ to: token, title, body, data, sound: "default" });
  }

  if (!messages.length) return;

  // Batch into chunks of 100 (Expo limit)
  const chunks = expo.chunkPushNotifications(messages);
  const staleTokens = [];

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      tickets.forEach((ticket, i) => {
        if (ticket.status === "error") {
          if (
            ticket.details?.error === "DeviceNotRegistered" ||
            ticket.details?.error === "InvalidCredentials"
          ) {
            staleTokens.push(chunk[i].to);
          }
          logger.warn("[push] ticket error", {
            token: chunk[i].to,
            error: ticket.details?.error,
          });
        }
      });
    } catch (err) {
      logger.error("[push] chunk send failed", { error: err.message });
    }
  }

  // Remove stale tokens in one write — don't await, fire-and-forget
  if (staleTokens.length) {
    User.updateOne(
      { _id: userId },
      { $pull: { expoPushTokens: { token: { $in: staleTokens } } } }
    ).catch((e) => logger.warn("[push] failed to prune stale tokens", { error: e.message }));
  }
};

module.exports = { sendPushNotification };
