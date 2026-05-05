const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");

const rootDir = () => path.resolve(process.cwd(), env.storageLocalDir);

const ensureSafe = (storageKey) => {
  if (!storageKey || storageKey.includes("..")) {
    throw new ApiError(400, "Invalid storage key.", { code: ERROR_CODES.VALIDATION_FAILED });
  }
};

const keyToPath = (storageKey) => {
  ensureSafe(storageKey);
  const abs = path.resolve(rootDir(), storageKey);
  if (!abs.startsWith(rootDir())) {
    throw new ApiError(400, "Invalid storage key.", { code: ERROR_CODES.VALIDATION_FAILED });
  }
  return abs;
};

const sanitizeSegment = (v) =>
  String(v).trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");

const buildStorageKey = ({ userId, folder, fileName }) => {
  const safeFolder = sanitizeSegment(folder) || "content";
  const ext = path.extname(fileName || "").toLowerCase();
  const base = path.basename(fileName || "asset", ext);
  const safe = sanitizeSegment(base) || "asset";
  return `${safeFolder}/${userId}/${Date.now()}-${crypto.randomUUID()}-${safe}${ext}`;
};

const publicBase = () => env.storagePublicBaseUrl.replace(/\/+$/, "");

const getPresignedUpload = async ({ userId, folder, fileName, mimeType, maxSizeBytes }) => {
  const storageKey = buildStorageKey({ userId, folder, fileName });
  const expiresInSeconds = 900;
  const token = jwt.sign(
    { storageKey, mimeType, maxSizeBytes, userId: String(userId), kind: "upload-ingest" },
    env.jwtSecret,
    { expiresIn: expiresInSeconds }
  );

  return {
    provider: "local",
    storageKey,
    uploadUrl: `${publicBase()}/ingest/${encodeURIComponent(token)}`,
    publicUrl: `${publicBase()}/files/${storageKey}`,
    method: "PUT",
    headers: { "Content-Type": mimeType },
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
};

const verifyIngestToken = (token) => {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (decoded.kind !== "upload-ingest") throw new Error("wrong kind");
    return decoded;
  } catch {
    throw new ApiError(401, "Invalid or expired upload token.", {
      code: ERROR_CODES.AUTH_TOKEN_INVALID,
    });
  }
};

const writeIngest = async ({ storageKey, stream, contentLength, mimeType, maxSizeBytes }) => {
  const abs = keyToPath(storageKey);
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  if (typeof contentLength === "number" && maxSizeBytes && contentLength > maxSizeBytes) {
    throw new ApiError(413, "File exceeds maximum allowed size.", {
      code: ERROR_CODES.UPLOAD_TOO_LARGE,
    });
  }

  const tmp = `${abs}.part`;
  const out = fs.createWriteStream(tmp);
  let written = 0;
  let aborted = false;

  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      written += chunk.length;
      if (maxSizeBytes && written > maxSizeBytes) {
        aborted = true;
        stream.destroy();
        out.destroy();
        reject(
          new ApiError(413, "File exceeds maximum allowed size.", {
            code: ERROR_CODES.UPLOAD_TOO_LARGE,
          })
        );
      }
    });
    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    stream.pipe(out);
  }).catch(async (err) => {
    try {
      await fsp.unlink(tmp);
    } catch {}
    throw err;
  });

  if (aborted) return;

  await fsp.rename(tmp, abs);

  return { storageKey, sizeBytes: written, mimeType };
};

const head = async (storageKey) => {
  try {
    const abs = keyToPath(storageKey);
    const stat = await fsp.stat(abs);
    return { sizeBytes: stat.size, exists: true };
  } catch {
    return { exists: false };
  }
};

const remove = async (storageKey) => {
  try {
    const abs = keyToPath(storageKey);
    await fsp.unlink(abs);
    return { removed: true };
  } catch (err) {
    if (err.code === "ENOENT") return { removed: false };
    throw err;
  }
};

module.exports = {
  getPresignedUpload,
  verifyIngestToken,
  writeIngest,
  head,
  remove,
  rootDir,
  keyToPath,
};
