const nodemailer = require("nodemailer");
const env = require("../config/env");
const logger = require("../core/logger");
const { render } = require("./mail/templates");

let cachedTransporter = null;

const buildSmtpTransporter = () => {
  const { host, port, user, password, secure } = env.mail.smtp;
  if (!host) {
    throw new Error("SMTP_HOST is required when MAIL_DRIVER=smtp.");
  }
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && password ? { user, pass: password } : undefined,
  });
};

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;
  if (env.mail.driver === "smtp") {
    cachedTransporter = buildSmtpTransporter();
  }
  return cachedTransporter;
};

/* Transactional mail is one-to-one, so no bulk flags here. Gmail still
   rewards a working List-Unsubscribe, and Auto-Submitted/Precedence stop
   out-of-office replies bouncing back at the sender. */
const buildDeliverabilityHeaders = () => {
  const headers = {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "All",
  };

  const unsub = [
    env.mail.unsubscribeUrl && `<${env.mail.unsubscribeUrl}>`,
    env.mail.supportEmail && `<mailto:${env.mail.supportEmail}?subject=unsubscribe>`,
  ].filter(Boolean);

  if (unsub.length) {
    headers["List-Unsubscribe"] = unsub.join(", ");
    if (env.mail.unsubscribeUrl) {
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
  }

  return headers;
};

const send = async ({ to, subject, template, data, html, text }) => {
  const driver = env.mail.driver;

  // Render template if provided. Caller-supplied html/text/subject win.
  let rendered = null;
  if (template) {
    rendered = render(template, data || {});
    if (!rendered) logger.warn("[mail] unknown template", { template });
  }

  const finalSubject = subject || rendered?.subject || "Prachar";
  const finalHtml    = html    || rendered?.html;
  const finalText    = text    || rendered?.text;

  // Console driver: log a friendly summary (incl. the OTP) and stop.
  if (driver === "console") {
    logger.info("[mail:console]", {
      to,
      subject: finalSubject,
      template,
      data,
    });
    return { delivered: false, driver: "console" };
  }

  if (driver === "smtp") {
    try {
      const transporter = getTransporter();
      const info = await transporter.sendMail({
        from: env.mail.from,
        to,
        replyTo: env.mail.replyTo || undefined,
        subject: finalSubject,
        text: finalText,
        html: finalHtml,
        headers: buildDeliverabilityHeaders(),
      });
      logger.info("[mail:smtp] sent", { to, subject: finalSubject, messageId: info.messageId });
      return { delivered: true, driver, messageId: info.messageId };
    } catch (err) {
      logger.error("[mail:smtp] failed", { to, subject: finalSubject, message: err.message });
      // Don't crash the request flow — auth/onboarding can still proceed; user
      // can re-trigger OTP. Surface the failure to logs/monitoring instead.
      return { delivered: false, driver, error: err.message };
    }
  }

  logger.warn("[mail] driver not implemented; email dropped", { driver, to, subject: finalSubject });
  return { delivered: false, driver };
};

module.exports = { send };
