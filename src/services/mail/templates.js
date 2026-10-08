/* ────────────────────────────────────────────────────────────
   Prachar transactional email templates
   ───────────────────────────────────────────────────────────
   Every template renders to { subject, html, text, preheader }.
   - Inline styles only (email clients strip <style> tags).
   - Tables for layout (bulletproof in Outlook/Yahoo).
   - Hex literals for colour (no CSS variables, no oklch).
   - Palette and radii mirror the app's design tokens in
     Contlate_frontend/components/Comman-components/theme/tokens.ts
     so email and app read as one product.
   - Inter-first stack, matching the app's loaded font.
   - Links are env-driven; anything unset is omitted rather than
     rendered as href="#", which reads as a phishing signal.
   ──────────────────────────────────────────────────────────── */

const env = require("../../config/env");

const BRAND = {
  name: "Prachar",
  tagline: "Marketing on autopilot for local business.",
  site: env.mail.siteUrl,
  privacy: env.mail.privacyUrl,
  terms: env.mail.termsUrl,
  support: env.mail.supportEmail,
};

/* Palette mirrors tokens.ts: color.* and palette.light.*
   Hairline rgba(10,10,20,0.08) is flattened against white for
   email clients that mishandle alpha borders. */
const C = {
  bg:          "#FBFBFD", // palette.light.canvas
  surface:     "#FFFFFF", // palette.light.card
  raised:      "#FCFCFE", // palette.light.raised
  border:      "#E7E7EC", // palette.light.hairline, flattened
  ink:         "#0C0C12", // palette.light.text
  ink2:        "#3A3A46", // body copy, between text and secondary
  secondary:   "#70707C", // palette.light.secondary
  muted:       "#A2A2AC", // palette.light.muted
  primary:     "#3E2AEE", // color.primary
  primaryDeep: "#2A1BB8", // color.primaryDeep
  primaryTint: "#F1EEFE", // palette.light.primaryTint
  danger:      "#EF4444", // color.danger
  dangerDeep:  "#991B1B",
  dangerTint:  "#FEF2F2",
};

/* radius.thumb 12 / radius.card 16 / radius.hero 24 */
const R = { thumb: "12px", card: "16px", hero: "24px" };

const FONT_SANS = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
const FONT_MONO = `'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace`;

const escape = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const preheaderBlock = (text) => `
  <div style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;color:${C.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${escape(text)}
  </div>
`;

/* Wordmark. The tile echoes the app icon: primary fill, radius.thumb. */
const logoBlock = () => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td width="36" height="36" align="center" valign="middle"
            style="background:${C.primary};border-radius:${R.thumb};color:#FFFFFF;font-family:${FONT_SANS};font-size:19px;font-weight:600;line-height:36px;text-align:center;">
            P
          </td></tr>
        </table>
      </td>
      <td style="vertical-align:middle;font-family:${FONT_SANS};font-size:18px;font-weight:600;color:${C.ink};letter-spacing:-0.18px;">
        ${BRAND.name}
      </td>
    </tr>
  </table>
`;

/* typography.display: 36 / 600 / -0.72 tracking. Trimmed to 30 for email. */
const headingBlock = (plain, accent) => `
  <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:30px;font-weight:600;color:${C.ink};letter-spacing:-0.6px;line-height:1.15;">
    ${escape(plain)} <span style="color:${C.primary};">${escape(accent)}</span>
  </h1>
`;

const otpBlock = (code) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 8px;">
    <tr>
      <td align="center" style="
        background:${C.primaryTint};
        border:1.5px solid ${C.primary};
        border-radius:${R.card};
        padding:22px 28px;
        font-family:${FONT_MONO};
        font-size:36px;
        font-weight:600;
        letter-spacing:0.32em;
        color:${C.primaryDeep};
        text-align:center;
      ">
        ${escape(String(code))}
      </td>
    </tr>
  </table>
`;

/* Renders nothing without a real destination — a dead href is a
   deliverability penalty, so the caller's text carries the CTA instead. */
const buttonBlock = ({ href, label }) => {
  if (!href) return "";
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto;">
    <tr>
      <td align="center" bgcolor="${C.primary}" style="border-radius:${R.thumb};">
        <a href="${escape(href)}" target="_blank"
          style="display:inline-block;padding:13px 26px;font-family:${FONT_SANS};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:${R.thumb};background:${C.primary};">
          ${escape(label)}
        </a>
      </td>
    </tr>
  </table>
`;
};

const noteBlock = ({ tone = "neutral", label, body }) => {
  const bg = tone === "danger" ? C.dangerTint : tone === "primary" ? C.primaryTint : C.bg;
  const fg = tone === "danger" ? C.dangerDeep : C.ink2;
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;background:${bg};border-radius:${R.thumb};">
    <tr><td style="padding:14px 18px;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${fg};">
      ${label ? `<strong style="color:${fg};">${escape(label)}</strong> ` : ""}${body}
    </td></tr>
  </table>
`;
};

const footerBlock = () => {
  const links = [
    BRAND.privacy && `<a href="${escape(BRAND.privacy)}" style="color:${C.muted};text-decoration:underline;">Privacy</a>`,
    BRAND.terms && `<a href="${escape(BRAND.terms)}" style="color:${C.muted};text-decoration:underline;">Terms</a>`,
    BRAND.support && `<a href="mailto:${escape(BRAND.support)}" style="color:${C.muted};text-decoration:underline;">Contact</a>`,
  ].filter(Boolean).join("&nbsp;·&nbsp;");

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:36px;border-top:1px solid ${C.border};">
    <tr><td style="padding:22px 0 0;font-family:${FONT_SANS};font-size:12px;line-height:1.55;color:${C.muted};">
      <div style="margin-bottom:6px;color:${C.secondary};font-weight:500;">${BRAND.name} · ${BRAND.tagline}</div>
      <div>© ${new Date().getFullYear()} ${BRAND.name}. You're receiving this because you have an account with us.</div>
      ${links ? `<div style="margin-top:8px;">${links}</div>` : ""}
    </td></tr>
  </table>
`;
};

/* Wraps any inner HTML with the standard Prachar email shell. */
const wrap = ({ preheader, inner }) => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${BRAND.name}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
  ${preheaderBlock(preheader || "")}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${C.bg}" style="background:${C.bg};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"
          style="width:100%;max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:${R.hero};">
          <tr><td style="padding:36px 40px 32px;">
            ${logoBlock()}
            <div style="height:28px;line-height:28px;">&nbsp;</div>
            ${inner}
            ${footerBlock()}
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const signoff = () => [
  ``,
  `${BRAND.name} · ${BRAND.tagline}`,
  `© ${new Date().getFullYear()} ${BRAND.name}`,
].join("\n");

const openAppLine = () =>
  BRAND.site ? `Open ${BRAND.name}: ${BRAND.site}` : `Open the ${BRAND.name} app to continue.`;

/* ════════════════════════════════════════════════════════════
   Templates
═══════════════════════════════════════════════════════════ */

const verifyEmail = ({ name, code }) => {
  const subject = `${code} is your ${BRAND.name} verification code`;
  const preheader = `Your code is ${code}. It expires in 10 minutes.`;

  const inner = `
    ${headingBlock("Verify your", "email.")}
    <p style="margin:0 0 8px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, welcome to ${BRAND.name}. Use the code below to finish setting up your account.
    </p>

    ${otpBlock(code)}

    <p style="margin:14px 0 0;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.secondary};text-align:center;">
      This code expires in <strong style="color:${C.ink2};">10 minutes</strong>. If you didn't request it, you can safely ignore this email.
    </p>

    ${noteBlock({
      label: "Heads up:",
      body: `${BRAND.name} will never ask you to share this code over the phone or chat. Keep it to yourself.`,
    })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Welcome to ${BRAND.name}. Your verification code is:`,
    ``,
    `    ${code}`,
    ``,
    `This code expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    `${BRAND.name} will never ask you to share this code over the phone or chat.`,
    signoff(),
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const passwordReset = ({ name, code }) => {
  const subject = `${code} is your ${BRAND.name} password reset code`;
  const preheader = `Your password reset code is ${code}. Expires in 10 minutes.`;

  const inner = `
    ${headingBlock("Reset your", "password.")}
    <p style="margin:0 0 8px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, we got a request to reset your password. Use the code below to set a new one.
    </p>

    ${otpBlock(code)}

    <p style="margin:14px 0 0;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.secondary};text-align:center;">
      This code expires in <strong style="color:${C.ink2};">10 minutes</strong>. If you didn't ask to reset, ignore this email — your password stays unchanged.
    </p>

    ${noteBlock({
      label: "Security tip:",
      body: "Pick something you don't use elsewhere. A passphrase of 3–4 random words beats a complicated single word.",
    })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Use this code to reset your ${BRAND.name} password:`,
    ``,
    `    ${code}`,
    ``,
    `This code expires in 10 minutes. If you didn't request it, ignore this email — your password is unchanged.`,
    signoff(),
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const publishFailed = ({ name, platform, accountName, error }) => {
  const accountLabel = accountName || platform || "your account";
  const subject = "Your scheduled post failed to publish";
  const preheader = `We couldn't publish to ${accountLabel} after multiple attempts.`;

  const inner = `
    <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:28px;font-weight:600;color:${C.ink};letter-spacing:-0.56px;line-height:1.15;">
      Post failed to <span style="color:${C.danger};">publish.</span>
    </h1>
    <p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, we tried publishing your scheduled post to <strong>${escape(accountLabel)}</strong> multiple times but couldn't complete it.
    </p>

    ${error ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:18px;background:${C.dangerTint};border-left:3px solid ${C.danger};border-radius:0 ${R.thumb} ${R.thumb} 0;">
      <tr><td style="padding:12px 16px;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.dangerDeep};">
        <strong>Error:</strong> ${escape(String(error).slice(0, 200))}
      </td></tr>
    </table>
    ` : ""}

    <p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      This can happen when a connected account's access has changed. Open ${BRAND.name} to reconnect the account and reschedule your post.
    </p>

    ${buttonBlock({ href: BRAND.site, label: `Open ${BRAND.name}` })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `We couldn't publish your scheduled post to ${accountLabel} after multiple attempts.`,
    error ? `Error: ${String(error).slice(0, 200)}` : "",
    ``,
    `${openAppLine()}`,
    signoff(),
  ].filter(Boolean).join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const accountExpired = ({ name, platform, accountName }) => {
  const accountLabel = accountName || platform || "your account";
  const subject = "Action needed: reconnect your social account";
  const preheader = `Your ${accountLabel} connection expired — reconnect to keep publishing.`;

  const inner = `
    ${headingBlock("Reconnect", `${accountLabel}.`)}
    <p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, the connection to your <strong>${escape(accountLabel)}</strong> account has expired. Scheduled posts will be paused until you reconnect.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;background:${C.primaryTint};border-radius:${R.thumb};">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 6px;font-family:${FONT_SANS};font-size:15px;font-weight:600;color:${C.ink};">Why did this happen?</p>
        <p style="margin:0;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.ink2};">
          Social platforms periodically require re-authorization for security. It takes less than a minute to reconnect.
        </p>
      </td></tr>
    </table>

    ${buttonBlock({ href: BRAND.site, label: "Reconnect account" })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Your ${accountLabel} connection has expired. Scheduled posts are paused.`,
    ``,
    `${openAppLine()}`,
    signoff(),
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const accountDisconnected = ({ name, platform, accountName }) => {
  const accountLabel = accountName || platform || "your account";
  const subject = "Your social account was disconnected";
  const preheader = `${accountLabel} was disconnected — reconnect to resume publishing.`;

  const inner = `
    <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:28px;font-weight:600;color:${C.ink};letter-spacing:-0.56px;line-height:1.15;">
      Account <span style="color:${C.danger};">disconnected.</span>
    </h1>
    <p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, your <strong>${escape(accountLabel)}</strong> account was disconnected — possibly via the platform's security settings. Any pending scheduled posts for this account are paused.
    </p>

    ${buttonBlock({ href: BRAND.site, label: `Reconnect in ${BRAND.name}` })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Your ${accountLabel} account was disconnected.`,
    `Pending scheduled posts are paused until you reconnect.`,
    ``,
    `${openAppLine()}`,
    signoff(),
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const permissionsRevoked = ({ name, platform, accountName }) => {
  const accountLabel = accountName || platform || "your account";
  const subject = `${BRAND.name} permissions revoked — action needed`;
  const preheader = `${BRAND.name} lost access to ${accountLabel}. Reconnect to continue.`;

  const inner = `
    <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:28px;font-weight:600;color:${C.ink};letter-spacing:-0.56px;line-height:1.15;">
      Permissions <span style="color:${C.danger};">revoked.</span>
    </h1>
    <p style="margin:0 0 18px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, access to <strong>${escape(accountLabel)}</strong> was revoked, likely from the platform's app settings. ${BRAND.name} can no longer publish on your behalf until you reconnect.
    </p>

    ${noteBlock({
      tone: "danger",
      label: "Note:",
      body: `You may have removed ${BRAND.name} from your connected apps on ${escape(platform || "the platform")}. Reconnecting re-grants the required permissions.`,
    })}

    ${buttonBlock({ href: BRAND.site, label: "Reconnect and grant access" })}
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `${BRAND.name}'s access to ${accountLabel} was revoked.`,
    `Publishing is paused until you reconnect and re-grant permissions.`,
    ``,
    `${openAppLine()}`,
    signoff(),
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const TEMPLATES = {
  verify_email:         verifyEmail,
  password_reset:       passwordReset,
  publish_failed:       publishFailed,
  account_expired:      accountExpired,
  account_disconnected: accountDisconnected,
  permissions_revoked:  permissionsRevoked,
};

const render = (templateName, data = {}) => {
  const fn = TEMPLATES[templateName];
  if (!fn) return null;
  return fn(data);
};

module.exports = { render, TEMPLATES, BRAND };
