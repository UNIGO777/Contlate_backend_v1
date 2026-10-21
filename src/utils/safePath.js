const path = require("path");
const env = require("../config/env");

/**
 * Guard for file paths that arrive from a client.
 *
 * Product images are uploaded in one request and referenced by path in a
 * later one, so the path makes a round trip through the client. Nothing
 * stops a caller sending back a different path than the one we issued —
 * "../../../etc/passwd", or another business's folder — and the poster
 * worker reads whatever it is handed and ships the bytes to OpenAI.
 *
 * So a stored path is only honoured when it really does sit inside the
 * directory we would have written it to.
 *
 * @param {string} candidate   path as supplied by the client
 * @param {string} subdir      e.g. "product-images"
 * @param {string} businessId  the owning business
 * @returns {string} the resolved path, or "" if it is not ours
 */
const resolveOwnedUpload = (candidate, subdir, businessId) => {
  if (!candidate || typeof candidate !== "string") return "";

  const root = path.resolve(env.storageLocalDir, subdir, String(businessId));
  const resolved = path.resolve(candidate);

  // path.relative gives "" for the directory itself and starts with ".." for
  // anything outside it. The separator check stops "/uploads/biz1-evil" from
  // passing as a prefix match of "/uploads/biz1".
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";

  return resolved;
};

module.exports = { resolveOwnedUpload };
