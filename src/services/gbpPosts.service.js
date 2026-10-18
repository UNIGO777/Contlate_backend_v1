const logger = require("../core/logger");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const GbpAccount = require("../modules/seo/gbpAccount.model");
const gbpOAuth = require("./gbpOAuth.service");

/**
 * Local posts live on the older My Business v4 surface, not the newer
 * Business Information API — Google never moved them across. That API is
 * allowlisted per project, which is why a call can fail with 403 even when
 * the OAuth scope is correct.
 */
const MYBUSINESS_V4 = "https://mybusiness.googleapis.com/v4";

/** Google rejects a summary over 1500 characters outright. */
const MAX_SUMMARY = 1500;

const CALL_TO_ACTIONS = Object.freeze([
  "BOOK",
  "ORDER",
  "SHOP",
  "LEARN_MORE",
  "SIGN_UP",
  "CALL",
]);

const classify = (status, body) => {
  const err = new Error(
    body?.error?.message || `Google Business Profile request failed (HTTP ${status}).`
  );
  err.statusCode = status;
  err.googleStatus = body?.error?.status || "";

  if (status === 401) err.failureType = "recoverable";       // reconnect
  else if (status === 403) err.failureType = "permanent";    // API not enabled / no permission
  else if (status === 429) err.failureType = "retryable";    // quota
  else if (status >= 500) err.failureType = "retryable";
  else err.failureType = "permanent";

  return err;
};

const accountForBusiness = async (businessId) => {
  const account = await GbpAccount.findOne({ businessId });
  if (!account) {
    throw new ApiError(400, "Google Business Profile is not connected.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }
  if (!account.gbpLocationId) {
    throw new ApiError(400, "No Google Business Profile location selected.", {
      code: ERROR_CODES.GBP_ACCOUNT_NOT_FOUND,
    });
  }
  return account;
};

/**
 * Publish one local post.
 *
 * @param {object}  args
 * @param {string}  args.businessId
 * @param {string}  args.summary       — post body
 * @param {string}  [args.imageUrl]    — must be publicly reachable; Google fetches it
 * @param {object}  [args.callToAction]
 * @returns {{ name: string, searchUrl: string }}
 */
const publishLocalPost = async ({ businessId, summary, imageUrl, callToAction }) => {
  const account = await accountForBusiness(businessId);
  const accessToken = await gbpOAuth.getValidAccessToken(account);

  const body = {
    languageCode: "en-US",
    summary: String(summary || "").slice(0, MAX_SUMMARY),
    topicType: "STANDARD",
  };

  if (imageUrl) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }];
  }

  // A call to action without a URL is rejected, and CALL takes none at all.
  const action = callToAction?.actionType;
  if (action && CALL_TO_ACTIONS.includes(action)) {
    if (action === "CALL") {
      body.callToAction = { actionType: action };
    } else if (callToAction.url) {
      body.callToAction = { actionType: action, url: callToAction.url };
    }
  }

  // gbpLocationId is stored as "accounts/x/locations/y" or bare "locations/y"
  // depending on where it came from; v4 wants the full path.
  const locationPath = account.gbpLocationId.includes("accounts/")
    ? account.gbpLocationId
    : `${account.gbpAccountId}/${account.gbpLocationId}`.replace(/\/+/g, "/");

  const url = `${MYBUSINESS_V4}/${locationPath}/localPosts`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = classify(res.status, json);
    logger.warn("[gbpPosts] publish failed", {
      businessId: String(businessId),
      status: res.status,
      failureType: err.failureType,
      message: err.message,
    });
    throw err;
  }

  return {
    name: json.name || "",
    searchUrl: json.searchUrl || "",
  };
};

/**
 * Read a post back from Google. Used to pick up view and click counts, and to
 * notice posts removed on Google's side.
 */
const getLocalPost = async (businessId, postName) => {
  const account = await accountForBusiness(businessId);
  const accessToken = await gbpOAuth.getValidAccessToken(account);

  const res = await fetch(`${MYBUSINESS_V4}/${postName}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw classify(res.status, json);
  return json;
};

const deleteLocalPost = async (businessId, postName) => {
  const account = await accountForBusiness(businessId);
  const accessToken = await gbpOAuth.getValidAccessToken(account);

  const res = await fetch(`${MYBUSINESS_V4}/${postName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const json = await res.json().catch(() => ({}));
    throw classify(res.status, json);
  }
  return true;
};

module.exports = {
  publishLocalPost,
  getLocalPost,
  deleteLocalPost,
  CALL_TO_ACTIONS,
  MAX_SUMMARY,
};
