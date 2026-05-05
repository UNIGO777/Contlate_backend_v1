const { isNonEmptyString } = require("../../validators/common.validator");
const { ALLOWED_MIME_TYPES, UPLOAD_PURPOSES } = require("../../constants/upload");

const finalize = (details, value) =>
  details.length ? { error: "Validation failed.", details } : { value };

const validatePrepareUploadInput = (req) => {
  const { fileName, mimeType, folder, purpose } = req.body || {};
  const details = [];

  if (!isNonEmptyString(fileName)) details.push("fileName is required.");
  if (!isNonEmptyString(mimeType)) details.push("mimeType is required.");
  else if (!ALLOWED_MIME_TYPES.includes(mimeType.trim().toLowerCase())) {
    details.push(`mimeType must be one of: ${ALLOWED_MIME_TYPES.join(", ")}.`);
  }
  if (purpose !== undefined && !Object.values(UPLOAD_PURPOSES).includes(purpose)) {
    details.push("purpose is invalid.");
  }

  return finalize(details, {
    fileName: isNonEmptyString(fileName) ? fileName.trim() : fileName,
    mimeType: isNonEmptyString(mimeType) ? mimeType.trim().toLowerCase() : mimeType,
    folder: isNonEmptyString(folder) ? folder.trim() : undefined,
    purpose: purpose || UPLOAD_PURPOSES.CONTENT,
  });
};

const validateConfirmUploadInput = (req) => {
  const { mediaAssetId } = req.body || {};
  const details = [];
  if (!isNonEmptyString(mediaAssetId)) details.push("mediaAssetId is required.");
  return finalize(details, { mediaAssetId: mediaAssetId && mediaAssetId.trim() });
};

module.exports = { validatePrepareUploadInput, validateConfirmUploadInput };
