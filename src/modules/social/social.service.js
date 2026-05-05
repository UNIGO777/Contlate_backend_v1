const mongoose = require("mongoose");
const ApiError = require("../../core/ApiError");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const SocialAccount = require("./social.model");

const ensureValidId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new ApiError(400, `${label} is invalid.`);
  }
};

const sanitizeSocialAccount = (account) => ({
  id: account._id.toString(),
  userId: account.userId.toString(),
  businessId: account.businessId.toString(),
  platform: account.platform,
  accountName: account.accountName,
  accountId: account.accountId,
  status: account.status,
  tokenExpiresAt: account.tokenExpiresAt,
  lastSyncedAt: account.lastSyncedAt,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

const connectSocialAccount = async ({ userId, businessId, payload }) => {
  let account = await SocialAccount.findOne({
    userId,
    platform: payload.platform,
    accountId: payload.accountId,
  });

  if (account) {
    account.accountName = payload.accountName;
    account.accessToken = payload.accessToken;
    account.refreshToken = payload.refreshToken;
    account.tokenExpiresAt = payload.tokenExpiresAt;
    account.status = payload.status;
    account.lastSyncedAt = new Date();
    await account.save();
  } else {
    account = await SocialAccount.create({
      userId,
      businessId,
      ...payload,
      lastSyncedAt: new Date(),
    });
  }

  return sanitizeSocialAccount(account);
};

const listSocialAccountsByUserId = async (userId) => {
  const accounts = await SocialAccount.find({ userId }).sort({ createdAt: -1 });
  return accounts.map(sanitizeSocialAccount);
};

const getSocialAccountById = async ({ userId, socialAccountId }) => {
  ensureValidId(socialAccountId, "socialAccountId");

  const account = await SocialAccount.findOne({ _id: socialAccountId, userId });

  if (!account) {
    throw new ApiError(404, "Social account not found.");
  }

  return sanitizeSocialAccount(account);
};

const updateSocialAccount = async ({ userId, socialAccountId, payload }) => {
  ensureValidId(socialAccountId, "socialAccountId");

  const account = await SocialAccount.findOne({ _id: socialAccountId, userId });

  if (!account) {
    throw new ApiError(404, "Social account not found.");
  }

  Object.assign(account, payload);
  account.lastSyncedAt = new Date();
  await account.save();

  return sanitizeSocialAccount(account);
};

const disconnectSocialAccount = async ({ userId, socialAccountId }) => {
  ensureValidId(socialAccountId, "socialAccountId");

  const account = await SocialAccount.findOne({ _id: socialAccountId, userId });

  if (!account) {
    throw new ApiError(404, "Social account not found.");
  }

  account.status = SOCIAL_ACCOUNT_STATUS.DISCONNECTED;
  account.accessToken = "";
  account.refreshToken = "";
  account.lastSyncedAt = new Date();
  await account.save();

  return sanitizeSocialAccount(account);
};

module.exports = {
  connectSocialAccount,
  listSocialAccountsByUserId,
  getSocialAccountById,
  updateSocialAccount,
  disconnectSocialAccount,
};
