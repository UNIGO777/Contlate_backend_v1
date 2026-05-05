const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { CONTENT_STATUS } = require("../../constants/contentStatus");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const Content = require("../content/content.model");
const Schedule = require("../schedule/schedule.model");
const SocialAccount = require("../social/social.model");
const Business = require("../business/business.model");
const usageService = require("../usage/usage.service");
const subscriptionService = require("../subscription/subscription.service");

const countByStatus = async (Model, userId) => {
  const rows = await Model.aggregate([
    { $match: { userId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  return rows.reduce((acc, r) => {
    acc[r._id] = r.count;
    return acc;
  }, {});
};

const getOverview = async (userId) => {
  const userObjectId = require("mongoose").Types.ObjectId.createFromHexString(
    String(userId)
  );

  const [
    business,
    contentByStatus,
    scheduleByStatus,
    socialByStatus,
    usage,
    subscription,
    upcomingSchedules,
  ] = await Promise.all([
    Business.findOne({ userId: userObjectId }).lean(),
    countByStatus(Content, userObjectId),
    countByStatus(Schedule, userObjectId),
    countByStatus(SocialAccount, userObjectId),
    usageService.getUsageSummary(userId),
    subscriptionService.getSubscriptionByUserId(userId),
    Schedule.find({
      userId: userObjectId,
      status: SCHEDULE_STATUS.PENDING,
      scheduledAt: { $gte: new Date() },
    })
      .sort({ scheduledAt: 1 })
      .limit(5)
      .lean(),
  ]);

  return {
    business: business
      ? {
          id: business._id.toString(),
          name: business.businessName,
          isCompleted: business.isCompleted,
        }
      : null,
    content: {
      total: Object.values(contentByStatus).reduce((a, b) => a + b, 0),
      byStatus: contentByStatus,
      ready: contentByStatus[CONTENT_STATUS.READY] || 0,
      published: contentByStatus[CONTENT_STATUS.PUBLISHED] || 0,
    },
    schedules: {
      total: Object.values(scheduleByStatus).reduce((a, b) => a + b, 0),
      byStatus: scheduleByStatus,
      pending: scheduleByStatus[SCHEDULE_STATUS.PENDING] || 0,
      published: scheduleByStatus[SCHEDULE_STATUS.PUBLISHED] || 0,
      failed: scheduleByStatus[SCHEDULE_STATUS.FAILED] || 0,
    },
    social: {
      total: Object.values(socialByStatus).reduce((a, b) => a + b, 0),
      connected: socialByStatus[SOCIAL_ACCOUNT_STATUS.CONNECTED] || 0,
      byStatus: socialByStatus,
    },
    upcomingSchedules: upcomingSchedules.map((s) => ({
      id: s._id.toString(),
      contentId: s.contentId.toString(),
      socialAccountId: s.socialAccountId.toString(),
      scheduledAt: s.scheduledAt,
      timezone: s.timezone,
    })),
    usage,
    subscription: subscription.subscription,
  };
};

const getPublishTrend = async (userId, { days = 14 } = {}) => {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const rows = await Schedule.aggregate([
    {
      $match: {
        userId: require("mongoose").Types.ObjectId.createFromHexString(String(userId)),
        publishedAt: { $gte: since },
        status: SCHEDULE_STATUS.PUBLISHED,
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$publishedAt", timezone: "UTC" },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return {
    days,
    series: rows.map((r) => ({ date: r._id, count: r.count })),
  };
};

module.exports = { getOverview, getPublishTrend };
