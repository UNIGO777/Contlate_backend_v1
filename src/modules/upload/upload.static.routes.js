const express = require("express");
const fsp = require("fs/promises");
const path = require("path");
const env = require("../../config/env");
const asyncHandler = require("../../core/asyncHandler");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const local = require("../../services/storage/local.driver");

const router = express.Router();

// PUT /static/ingest/:token  (raw body)
router.put(
  "/ingest/:token",
  express.raw({ type: "*/*", limit: "50mb" }),
  asyncHandler(async (req, res) => {
    const decoded = local.verifyIngestToken(req.params.token);
    const mimeType = req.headers["content-type"];
    if (mimeType && decoded.mimeType && !mimeType.startsWith(decoded.mimeType)) {
      throw new ApiError(400, "Content-Type mismatch.", {
        code: ERROR_CODES.UPLOAD_INVALID_MIME,
      });
    }

    const contentLength = Number(req.headers["content-length"]) || 0;
    if (decoded.maxSizeBytes && contentLength > decoded.maxSizeBytes) {
      throw new ApiError(413, "File exceeds maximum allowed size.", {
        code: ERROR_CODES.UPLOAD_TOO_LARGE,
      });
    }

    const abs = local.keyToPath(decoded.storageKey);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, req.body || Buffer.alloc(0));

    return res.status(200).json({
      success: true,
      statusCode: 200,
      message: "Uploaded.",
      data: { storageKey: decoded.storageKey, sizeBytes: (req.body || Buffer.alloc(0)).length },
    });
  })
);

// GET /static/files/*  (serve files from the local storage dir)
router.get(
  "/files/*filepath",
  asyncHandler(async (req, res) => {
    const key = Array.isArray(req.params.filepath)
      ? req.params.filepath.join("/")
      : req.params.filepath;
    const abs = local.keyToPath(key);
    try {
      await fsp.access(abs);
    } catch {
      throw new ApiError(404, "File not found.", { code: ERROR_CODES.NOT_FOUND });
    }
    return res.sendFile(abs);
  })
);

// Only exported when STORAGE_PROVIDER=local.
module.exports = env.storageProvider === "local" ? router : express.Router();
