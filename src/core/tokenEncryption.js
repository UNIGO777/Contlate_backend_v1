const crypto = require("crypto");
const env = require("../config/env");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key for a given version.
 * Currently only version 1 is supported; add more as needed.
 */
function getKey(version) {
  const keyMap = {
    1: env.encryption.tokenKey1,
  };
  const raw = keyMap[version];
  if (!raw) {
    throw new Error(`No encryption key configured for version ${version}.`);
  }
  // Derive a 32-byte key from the raw secret using SHA-256
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM with the current encryption version.
 * Returns a string in the format: version:iv:authTag:ciphertext (all hex-encoded).
 */
function encrypt(plaintext) {
  const version = env.encryption.currentVersion;
  const key = getKey(version);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${version}:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a token string produced by encrypt().
 * Reads the version prefix to select the correct key.
 */
function decrypt(encryptedString) {
  const parts = encryptedString.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted token format.");
  }

  const [versionStr, ivHex, authTagHex, ciphertext] = parts;
  const version = parseInt(versionStr, 10);
  const key = getKey(version);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Returns the encryption version embedded in an encrypted string.
 */
function getVersion(encryptedString) {
  const colonIndex = encryptedString.indexOf(":");
  return colonIndex > 0 ? parseInt(encryptedString.substring(0, colonIndex), 10) : null;
}

module.exports = { encrypt, decrypt, getVersion };
