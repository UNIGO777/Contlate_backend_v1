/* ────────────────────────────────────────────────────────────
   Postly transactional email templates
   ───────────────────────────────────────────────────────────
   Every template renders to { subject, html, text, preheader }.
   - Inline styles only (email clients strip <style> tags).
   - Tables for layout (bulletproof in Outlook/Yahoo).
   - Hex literals for colour (no CSS variables, no oklch).
   - Web-safe font stack with Inter fallback.
   - Brand: violet #7c3aed accent, off-white #fbfbfd canvas,
     Georgia italic for the serif accent word in headlines.
   ──────────────────────────────────────────────────────────── */

const C = {
  bg:        "#fbfbfd",
  surface:   "#ffffff",
  border:    "#e8e7ee",
  ink:       "#2a2a35",
  ink2:      "#4f4f5d",
  muted:     "#7a7a85",
  faint:     "#a8a8b1",
  accent:    "#7c3aed",
  accent2:   "#5b21b6",
  accentSoft:"#f1ebff",
};

const FONT_SANS = `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
const FONT_SERIF = `'Georgia', 'Times New Roman', serif`;

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

const logoBlock = () => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td width="36" height="36" align="center" valign="middle"
            style="background:linear-gradient(135deg,${C.accent},#a855f7);background-color:${C.accent};border-radius:9px;color:#ffffff;font-family:${FONT_SERIF};font-size:22px;font-weight:400;line-height:36px;">
            P
          </td></tr>
        </table>
      </td>
      <td style="vertical-align:middle;font-family:${FONT_SANS};font-size:18px;font-weight:600;color:${C.ink};letter-spacing:-0.01em;">
        Postly
      </td>
    </tr>
  </table>
`;

const otpBlock = (code) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 8px;">
    <tr>
      <td align="center" style="
        background:${C.accentSoft};
        border:1.5px solid ${C.accent};
        border-radius:12px;
        padding:22px 28px;
        font-family:'SF Mono','JetBrains Mono','Menlo',monospace;
        font-size:36px;
        font-weight:600;
        letter-spacing:0.32em;
        color:${C.accent2};
        text-align:center;
      ">
        ${escape(String(code))}
      </td>
    </tr>
  </table>
`;

const buttonBlock = ({ href, label }) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto;">
    <tr>
      <td align="center" bgcolor="${C.accent}" style="border-radius:10px;">
        <a href="${escape(href)}" target="_blank"
          style="display:inline-block;padding:13px 26px;font-family:${FONT_SANS};font-size:14.5px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;background:${C.accent};">
          ${escape(label)}
        </a>
      </td>
    </tr>
  </table>
`;

const footerBlock = () => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:36px;border-top:1px solid ${C.border};">
    <tr><td style="padding:22px 0 0;font-family:${FONT_SANS};font-size:12px;line-height:1.55;color:${C.muted};">
      <div style="margin-bottom:6px;color:${C.ink2};font-weight:500;">Postly · Your social on autopilot.</div>
      <div>© 2026 Postly Inc. — You're receiving this because you have an account with us.</div>
      <div style="margin-top:8px;">
        <a href="#" style="color:${C.muted};text-decoration:underline;">Privacy</a>
        &nbsp;·&nbsp;
        <a href="#" style="color:${C.muted};text-decoration:underline;">Terms</a>
        &nbsp;·&nbsp;
        <a href="#" style="color:${C.muted};text-decoration:underline;">Help</a>
      </div>
    </td></tr>
  </table>
`;

/* Wraps any inner HTML with the standard Postly email shell. */
const wrap = ({ preheader, inner }) => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>Postly</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
  ${preheaderBlock(preheader || "")}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${C.bg}" style="background:${C.bg};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560"
          style="width:100%;max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:18px;box-shadow:0 1px 2px rgba(20,18,38,0.04),0 8px 24px -8px rgba(20,18,38,0.06);">
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

/* ════════════════════════════════════════════════════════════
   Templates
═══════════════════════════════════════════════════════════ */

const verifyEmail = ({ name, code }) => {
  const subject = "Your Postly verification code";
  const preheader = `Your code is ${code}. It expires in 10 minutes.`;

  const inner = `
    <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:30px;font-weight:600;color:${C.ink};letter-spacing:-0.01em;line-height:1.1;">
      Verify your <span style="font-family:${FONT_SERIF};font-style:italic;font-weight:400;color:${C.accent};">email.</span>
    </h1>
    <p style="margin:0 0 8px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, welcome to Postly. Use the code below to finish setting up your workspace.
    </p>

    ${otpBlock(code)}

    <p style="margin:14px 0 0;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.muted};text-align:center;">
      This code expires in <strong style="color:${C.ink2};">10 minutes</strong>. If you didn't request it, you can safely ignore this email.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;background:${C.bg};border-radius:10px;">
      <tr><td style="padding:14px 18px;font-family:${FONT_SANS};font-size:12.5px;line-height:1.55;color:${C.muted};">
        <strong style="color:${C.ink2};">Heads up:</strong> Postly will never ask you to share this code over the phone or chat. Keep it to yourself.
      </td></tr>
    </table>
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Welcome to Postly. Your verification code is:`,
    ``,
    `    ${code}`,
    ``,
    `This code expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    ``,
    `Postly · Your social on autopilot.`,
    `© 2026 Postly Inc.`,
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const passwordReset = ({ name, code }) => {
  const subject = "Reset your Postly password";
  const preheader = `Your password reset code is ${code}. Expires in 10 minutes.`;

  const inner = `
    <h1 style="margin:0 0 10px;font-family:${FONT_SANS};font-size:30px;font-weight:600;color:${C.ink};letter-spacing:-0.01em;line-height:1.1;">
      Reset your <span style="font-family:${FONT_SERIF};font-style:italic;font-weight:400;color:${C.accent};">password.</span>
    </h1>
    <p style="margin:0 0 8px;font-family:${FONT_SANS};font-size:15px;line-height:1.6;color:${C.ink2};">
      Hi ${escape(name || "there")}, we got a request to reset your password. Use the code below to set a new one.
    </p>

    ${otpBlock(code)}

    <p style="margin:14px 0 0;font-family:${FONT_SANS};font-size:13px;line-height:1.55;color:${C.muted};text-align:center;">
      This code expires in <strong style="color:${C.ink2};">10 minutes</strong>. If you didn't ask to reset, ignore this email — your password stays unchanged.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;background:${C.bg};border-radius:10px;">
      <tr><td style="padding:14px 18px;font-family:${FONT_SANS};font-size:12.5px;line-height:1.55;color:${C.muted};">
        <strong style="color:${C.ink2};">Security tip:</strong> Pick something you don't use elsewhere. A passphrase of 3–4 random words beats a complicated single word.
      </td></tr>
    </table>
  `;

  const text = [
    `Hi ${name || "there"},`,
    ``,
    `Use this code to reset your Postly password:`,
    ``,
    `    ${code}`,
    ``,
    `This code expires in 10 minutes. If you didn't request it, ignore this email — your password is unchanged.`,
    ``,
    `Postly · Your social on autopilot.`,
    `© 2026 Postly Inc.`,
  ].join("\n");

  return { subject, preheader, html: wrap({ preheader, inner }), text };
};

const TEMPLATES = {
  verify_email:   verifyEmail,
  password_reset: passwordReset,
};

const render = (templateName, data = {}) => {
  const fn = TEMPLATES[templateName];
  if (!fn) return null;
  return fn(data);
};

module.exports = { render, TEMPLATES };
