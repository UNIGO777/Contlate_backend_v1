/**
 * Which image to show for a piece of content.
 *
 * This rule was written out separately in four places, each slightly
 * different, which is how published posters ended up loading in some screens
 * and not others. It lives here now so there is one answer.
 *
 * The order matters:
 *
 *   1. Not yet cleaned up → our own full-size poster. Best quality, and it is
 *      still on disk.
 *   2. Cleaned up → the archived thumbnail. Small, but ours, and it does not
 *      expire.
 *   3. No thumbnail → the platform's copy, as a last resort.
 *
 * Instagram's media urls used to be step 2, and that is what broke: they are
 * signed and expire about four and a half days after posting, so every post
 * quietly lost its image a few days after going out. They are kept as a
 * fallback only for posts cleaned up before thumbnails existed.
 */

/**
 * @param {object} content  Content document or lean object. Needs
 *   localImageDeleted, imageUrl, thumbnailUrl and socialPostUrls.
 * @param {(url: string) => string} [normalise]  Optional url normaliser, used
 *   by callers that rewrite hosts.
 * @returns {string|null}
 */
const displayImageUrl = (content, normalise) => {
  if (!content) return null;

  const fix = (u) => (u && normalise ? normalise(u) : u || null);

  if (!content.localImageDeleted) {
    return fix(content.imageUrl);
  }

  if (content.thumbnailUrl) {
    return fix(content.thumbnailUrl);
  }

  // Pre-thumbnail posts. Expect this to be expired more often than not.
  const link = (content.socialPostUrls || []).find((u) => u.mediaUrl) || {};
  return link.mediaUrl || null;
};

/** The permalink for a published post, which never expires. */
const permalinkFor = (content) => {
  const link = (content?.socialPostUrls || []).find((u) => u.postUrl) || {};
  return link.postUrl || "";
};

module.exports = { displayImageUrl, permalinkFor };
