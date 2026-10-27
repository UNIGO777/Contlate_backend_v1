/**
 * Recover published posters whose image no longer loads.
 *
 * The cleanup job deleted the full-size poster 24 hours after publishing but
 * left content.imageUrl pointing at it, so every published post started
 * 404ing. The fallback was Instagram's CDN copy, but those urls are signed
 * and expire within days, so those broke too.
 *
 * The worker now archives a thumbnail before deleting, which stops this
 * happening again. This script repairs the posts that already broke, by
 * pulling the image back from Instagram and writing the thumbnail that
 * should have been made at the time.
 *
 * Two sources are tried per post:
 *   1. the stored socialPostUrls[].mediaUrl — free, but often expired
 *   2. a fresh GET /{media-id} against the Graph API — costs one call, and
 *      only works while the account is still connected
 *
 * MUST be run on the server: the thumbnails have to land on the same disk
 * the API serves /static/files from.
 *
 * Usage:  node scripts/backfill-poster-thumbnails.js            (dry run)
 *         node scripts/backfill-poster-thumbnails.js --apply
 *         node scripts/backfill-poster-thumbnails.js --apply --no-api
 */
require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs/promises");
const sharp = require("sharp");
const env = require("../src/config/env");

const APPLY = process.argv.includes("--apply");
const NO_API = process.argv.includes("--no-api");

const Content = require("../src/modules/content/content.model");
const ContentPlan = require("../src/modules/poster/contentPlan.model");
const SocialAccount = require("../src/modules/social/social.model");

const fetchBuffer = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
};

/** Ask Instagram for a fresh, unexpired media url. */
const freshMediaUrl = async (content) => {
  if (NO_API) return null;
  const post = (content.socialPostUrls || []).find((s) => s.postId);
  if (!post) return null;

  const account = await SocialAccount.findOne({
    businessId: content.businessId,
    platform: "instagram",
    status: "connected",
  }).lean();
  if (!account?.accessToken) return null;

  try {
    const metaService = require("../src/services/meta.service");
    const instagramService = require("../src/services/instagram.service");
    const token = metaService.decryptToken(account.accessToken);
    const info = await instagramService.getMediaInfo(post.postId, token);
    return info?.mediaUrl || null;
  } catch (err) {
    console.log(`    graph lookup failed: ${err.message}`);
    return null;
  }
};

const writeThumb = async (buffer, businessId, basename) => {
  const dir = path.resolve(env.storageLocalDir, "thumbs", String(businessId));
  await fs.mkdir(dir, { recursive: true });
  const filename = `${basename}_thumb.jpg`;
  const filePath = path.join(dir, filename);
  const out = await sharp(buffer)
    .resize(600, 600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  await fs.writeFile(filePath, out);
  return {
    localPath: filePath,
    publicUrl: `${env.storagePublicBaseUrl}/files/thumbs/${businessId}/${filename}`,
    bytes: out.length,
  };
};

(async () => {
  await mongoose.connect(env.mongodbUri);
  console.log(APPLY ? "*** APPLYING ***" : "*** DRY RUN ***");

  const broken = await Content.find({
    localImageDeleted: true,
    thumbnailUrl: { $in: ["", null] },
  });

  console.log(`posts with a deleted original and no thumbnail: ${broken.length}\n`);

  let fixed = 0;
  let unrecoverable = 0;

  for (const content of broken) {
    const id = String(content._id);
    const basename = content.localImagePath
      ? path.basename(content.localImagePath, path.extname(content.localImagePath))
      : id;

    // Only bother if the url really is dead — a post that still loads needs
    // nothing doing.
    const live = await fetch(content.imageUrl).then((r) => r.ok).catch(() => false);
    if (live) {
      console.log(`${id}  still loads — skipped`);
      continue;
    }

    const stored = (content.socialPostUrls || [])[0]?.mediaUrl;
    let buffer = stored ? await fetchBuffer(stored).catch(() => null) : null;
    let source = buffer ? "stored mediaUrl" : null;

    if (!buffer) {
      const fresh = await freshMediaUrl(content);
      if (fresh) {
        buffer = await fetchBuffer(fresh).catch(() => null);
        if (buffer) source = "fresh Graph lookup";
      }
    }

    if (!buffer) {
      console.log(`${id}  UNRECOVERABLE — no usable image source`);
      unrecoverable++;
      continue;
    }

    if (!APPLY) {
      console.log(`${id}  would recover via ${source}`);
      fixed++;
      continue;
    }

    const thumb = await writeThumb(buffer, content.businessId, basename);
    content.thumbnailUrl = thumb.publicUrl;
    content.thumbnailPath = thumb.localPath;
    content.imageUrl = thumb.publicUrl;
    await content.save();

    await ContentPlan.updateOne(
      { businessId: content.businessId, "days.contentId": content._id },
      { $set: { "days.$.imageUrl": thumb.publicUrl } }
    );

    console.log(`${id}  recovered via ${source} (${(thumb.bytes / 1024).toFixed(0)} KB)`);
    fixed++;
  }

  console.log(`\nrecovered: ${fixed} | unrecoverable: ${unrecoverable}`);
  if (!APPLY) console.log("(no writes made — rerun with --apply)");
  await mongoose.disconnect();
})().catch((err) => {
  console.error("ERR", err);
  process.exit(1);
});
