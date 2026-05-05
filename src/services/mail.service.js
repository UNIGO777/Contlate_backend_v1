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

const send = async ({ to, subject, template, data, html, text }) => {
  const driver = env.mail.driver;

  // Render template if provided. Caller-supplied html/text/subject win.
  let rendered = null;
  if (template) {
    rendered = render(template, data || {});
    if (!rendered) logger.warn("[mail] unknown template", { template });
  }

  const finalSubject = subject || rendered?.subject || "Postly";
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
        subject: finalSubject,
        text: finalText,
        html: finalHtml,
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
