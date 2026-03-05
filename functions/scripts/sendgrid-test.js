/**
 * One-off script to test SendGrid send.
 * Run from functions dir: node scripts/sendgrid-test.js
 * Set env: SENDGRID_TEST_TO (recipient). From address defaults to danceupappcompany@gmail.com.
 * Requires GCP auth (e.g. gcloud auth application-default login) for Secret Manager.
 */
const path = require("path");

// Allow running from functions/ or project root
const functionsDir = path.resolve(__dirname, "..");
process.chdir(functionsDir);

const sendgridService = require("../services/sendgrid.service");

const DEFAULT_FROM = "danceupappcompany@gmail.com";

async function main() {
  const to = process.env.SENDGRID_TEST_TO;
  const from = process.env.SENDGRID_TEST_FROM || DEFAULT_FROM;

  if (!to) {
    console.error("Set SENDGRID_TEST_TO (recipient) then re-run.");
    process.exit(1);
  }

  const msg = {
    to,
    from,
    subject: "SendGrid test from DanceUp",
    text: "This is a test email sent via SendGrid.",
    html: "<strong>This is a test email sent via SendGrid.</strong>",
  };

  try {
    await sendgridService.sendEmail(msg);
    console.log("Email sent successfully.");
  } catch (err) {
    console.error("Send failed:", err.response?.body || err.message);
    process.exit(1);
  }
}

main();
