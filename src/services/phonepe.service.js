const crypto = require("crypto");
const env = require("../config/env");
const logger = require("../core/logger");

const SANDBOX_BASE = "https://api-preprod.phonepe.com/apis/pg-sandbox";
const PROD_BASE    = "https://api.phonepe.com/apis/hermes";
const PAY_ENDPOINT = "/pg/v1/pay";

const isConfigured = () =>
  Boolean(env.phonepe.merchantId && env.phonepe.saltKey);

const getBase = () =>
  env.phonepe.env === "production" ? PROD_BASE : SANDBOX_BASE;

const sha256 = (str) =>
  crypto.createHash("sha256").update(str).digest("hex");

const buildXVerify = (base64Payload, endpoint) => {
  const hash = sha256(base64Payload + endpoint + env.phonepe.saltKey);
  return `${hash}####${env.phonepe.saltKeyIndex}`;
};

const buildStatusXVerify = (merchantId, transactionId) => {
  const path = `/pg/v1/status/${merchantId}/${transactionId}`;
  const hash = sha256(path + env.phonepe.saltKey);
  return `${hash}####${env.phonepe.saltKeyIndex}`;
};

/**
 * Creates a PhonePe Pay Page checkout.
 * Returns { redirectUrl, transactionId }.
 */
const createCheckout = async ({ userId, amount, transactionId, redirectUrl, callbackUrl }) => {
  if (!isConfigured()) {
    throw new Error("PhonePe is not configured on this server.");
  }

  const payload = {
    merchantId:            env.phonepe.merchantId,
    merchantTransactionId: transactionId,
    merchantUserId:        String(userId),
    amount:                Math.round(amount * 100), // convert ₹ to paise
    redirectUrl,
    redirectMode:          "REDIRECT",
    callbackUrl,
    paymentInstrument: { type: "PAY_PAGE" },
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const xVerify      = buildXVerify(base64Payload, PAY_ENDPOINT);

  const res = await fetch(`${getBase()}${PAY_ENDPOINT}`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VERIFY":     xVerify,
    },
    body: JSON.stringify({ request: base64Payload }),
  });

  const json = await res.json();

  if (!res.ok || !json.success) {
    logger.error("[phonepe] createCheckout failed", { status: res.status, json });
    throw new Error(json?.message || "PhonePe checkout creation failed.");
  }

  const payPageUrl = json.data?.instrumentResponse?.redirectInfo?.url;
  if (!payPageUrl) {
    throw new Error("PhonePe did not return a redirect URL.");
  }

  return { redirectUrl: payPageUrl, transactionId };
};

/**
 * Verifies a PhonePe S2S webhook callback.
 * Throws if the signature is invalid.
 * Returns the decoded payload.
 */
const verifyWebhook = (rawBody, xVerifyHeader) => {
  let body;
  try {
    body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch {
    throw new Error("Invalid webhook body.");
  }

  const base64Response = body.response;
  if (!base64Response) throw new Error("Missing response field in webhook.");

  // PhonePe sends: SHA256(base64Response + saltKey) + "####" + saltIndex
  const expected = `${sha256(base64Response + env.phonepe.saltKey)}####${env.phonepe.saltKeyIndex}`;

  const valid = crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(xVerifyHeader || "")
  );
  if (!valid) throw new Error("PhonePe webhook signature mismatch.");

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(base64Response, "base64").toString("utf8"));
  } catch {
    throw new Error("Could not decode PhonePe webhook payload.");
  }

  return decoded;
};

/**
 * Maps a PhonePe payment state to subscription plan/status changes.
 * Returns { plan, status, paid } or null if no action needed.
 */
const resolvePaymentOutcome = (decoded, planCode) => {
  const state = decoded?.data?.paymentState || decoded?.code;
  // PAYMENT_SUCCESS / PAYMENT_ERROR / PAYMENT_PENDING
  if (state === "PAYMENT_SUCCESS") {
    return { plan: planCode, status: "active", paid: true };
  }
  if (state === "PAYMENT_ERROR" || state === "PAYMENT_DECLINED") {
    return { plan: null, status: "expired", paid: false };
  }
  return null; // pending — do nothing
};

module.exports = {
  isConfigured,
  createCheckout,
  verifyWebhook,
  resolvePaymentOutcome,
  buildStatusXVerify,
};
