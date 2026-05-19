const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(process.cwd(), ".env"),
});

const requiredEnvVars = ["MONGODB_URI", "JWT_SECRET", "JWT_REFRESH_SECRET"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: toInt(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || "/api/v1",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  mongodbUri: process.env.MONGODB_URI,

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  bcryptSaltRounds: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),

  otpTtlMinutes: toInt(process.env.OTP_TTL_MINUTES, 10),
  otpMaxAttempts: toInt(process.env.OTP_MAX_ATTEMPTS, 5),
  loginMaxAttempts: toInt(process.env.LOGIN_MAX_ATTEMPTS, 10),
  loginLockoutMinutes: toInt(process.env.LOGIN_LOCKOUT_MINUTES, 15),

  storageProvider: process.env.STORAGE_PROVIDER || "local",
  storagePublicBaseUrl:
    process.env.STORAGE_PUBLIC_BASE_URL || "http://localhost:5000/static",
  storageLocalDir: process.env.STORAGE_LOCAL_DIR || "./uploads",
  s3: {
    region: process.env.S3_REGION || "",
    bucket: process.env.S3_BUCKET || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    presignExpiresSeconds: toInt(process.env.S3_PRESIGN_EXPIRES_SECONDS, 300),
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
    uploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER || "postly",
  },

  google: {
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY || "",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      "http://localhost:5000/api/v1/business/gbp/callback",
  },

  dataForSeo: {
    login: process.env.DATAFORSEO_LOGIN || "",
    password: process.env.DATAFORSEO_PASSWORD || "",
  },

  encryption: {
    tokenKey1: process.env.TOKEN_ENCRYPTION_KEY_1 || "",
    currentVersion: toInt(process.env.CURRENT_ENCRYPTION_VERSION, 1),
  },

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: toInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || "",
    db: toInt(process.env.REDIS_DB, 0),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model:  process.env.OPENAI_MODEL || "gpt-4o-mini",
    imageEffort: ["low", "medium", "high"].includes(process.env.POSTER_IMAGE_EFFORT)
      ? process.env.POSTER_IMAGE_EFFORT
      : "low",
  },

  meta: {
    appId: process.env.META_APP_ID || "",
    appSecret: process.env.META_APP_SECRET || "",
    redirectUri:
      process.env.META_REDIRECT_URI ||
      "http://localhost:5000/api/v1/social/oauth/meta/callback",
    graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
    oauthStateSecret: process.env.META_OAUTH_STATE_SECRET || process.env.JWT_SECRET,
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  },

  phonepe: {
    merchantId:    process.env.PHONEPE_MERCHANT_ID || "",
    saltKey:       process.env.PHONEPE_SALT_KEY || "",
    saltKeyIndex:  toInt(process.env.PHONEPE_SALT_KEY_INDEX, 1),
    // Set PHONEPE_ENV=production to hit live endpoints; any other value uses sandbox
    env:           process.env.PHONEPE_ENV || "sandbox",
  },

  mail: {
    driver: process.env.MAIL_DRIVER || "console",
    from: process.env.MAIL_FROM || "PostEngine <no-reply@postengine.local>",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: toInt(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER || "",
      password: process.env.SMTP_PASSWORD || "",
      secure: toBool(process.env.SMTP_SECURE, false),
    },
    resendApiKey: process.env.RESEND_API_KEY || "",
  },

  adminSeed: {
    email: process.env.ADMIN_SEED_EMAIL || "",
    password: process.env.ADMIN_SEED_PASSWORD || "",
    name: process.env.ADMIN_SEED_NAME || "PostEngine Admin",
  },

  adminPanelOrigin: process.env.ADMIN_PANEL_ORIGIN || "http://localhost:5173",
};

module.exports = env;
