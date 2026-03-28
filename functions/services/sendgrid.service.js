const sgMail = require("@sendgrid/mail");
const {getSecret} = require("../utils/secret-manager");

let apiKeySet = false;
let cachedApiKey = null;

/**
 * Ensure SendGrid API key is loaded from Secret Manager and set on sgMail.
 * @returns {Promise<void>}
 */
async function ensureApiKey() {
  if (apiKeySet) return;
  const key = await getSecret("sendgrid-api-key");
  if (!key || !key.trim()) {
    throw new Error("SendGrid API key not found in Secret Manager");
  }
  cachedApiKey = key.trim();
  sgMail.setApiKey(cachedApiKey);
  apiKeySet = true;
}

/**
 * Send an email via SendGrid.
 * @param {Object} msg - SendGrid message: { to, from, subject, text?, html?, categories? }
 * @returns {Promise<[Object, Object]>} SendGrid response
 */
async function sendEmail(msg) {
  await ensureApiKey();
  return sgMail.send(msg);
}

/**
 * Get SendGrid API key (for use by other modules that need to call SendGrid REST API)
 * @returns {Promise<string>}
 */
async function getApiKey() {
  await ensureApiKey();
  return cachedApiKey;
}

/**
 * Fetch category statistics from SendGrid (opens, clicks, delivered, etc.)
 * @param {string} category - Category name (e.g. marketing-<campaignId>)
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<{metrics: Object, error?: string}>} Aggregated metrics and optional error message
 */
async function getCategoryStats(category, startDate, endDate) {
  const key = await getApiKey();
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate || startDate,
    categories: category,
  });
  const url = `https://api.sendgrid.com/v3/categories/stats?${params.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  const emptyMetrics = {delivered: 0, opens: 0, unique_opens: 0, clicks: 0, unique_clicks: 0, bounces: 0, unsubscribes: 0, requests: 0};
  if (!res.ok) {
    const text = await res.text();
    let errMsg = text;
    try {
      const body = JSON.parse(text);
      if (body.errors && Array.isArray(body.errors)) {
        errMsg = body.errors.map((e) => e.message || e).join("; ");
      }
    } catch (_) {}
    console.warn("[SendGrid] getCategoryStats failed:", res.status, "category=" + category, "start=" + startDate, "end=" + endDate, errMsg);
    return {metrics: emptyMetrics, error: `SendGrid: ${res.status} ${errMsg}`};
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.warn("[SendGrid] getCategoryStats parse error:", e.message);
    return {metrics: emptyMetrics, error: "SendGrid: Invalid response"};
  }
  const allMetrics = {...emptyMetrics};
  if (Array.isArray(data)) {
    for (const day of data) {
      const stats = day.stats || [];
      for (const s of stats) {
        const m = s.metrics || {};
        if (s.name === category) {
          allMetrics.delivered += m.delivered || 0;
          allMetrics.opens += m.opens || 0;
          allMetrics.unique_opens += m.unique_opens || 0;
          allMetrics.clicks += m.clicks || 0;
          allMetrics.unique_clicks += m.unique_clicks || 0;
          allMetrics.bounces += m.bounces || 0;
          allMetrics.unsubscribes += m.unsubscribes || 0;
          allMetrics.requests += m.requests || 0;
        }
      }
    }
    if (allMetrics.delivered === 0 && allMetrics.requests === 0 && data.length > 0) {
      for (const day of data) {
        const stats = day.stats || [];
        for (const s of stats) {
          const m = s.metrics || {};
          allMetrics.delivered += m.delivered || 0;
          allMetrics.opens += m.opens || 0;
          allMetrics.unique_opens += m.unique_opens || 0;
          allMetrics.clicks += m.clicks || 0;
          allMetrics.unique_clicks += m.unique_clicks || 0;
          allMetrics.bounces += m.bounces || 0;
          allMetrics.unsubscribes += m.unsubscribes || 0;
          allMetrics.requests += m.requests || 0;
        }
      }
    }
  }
  return {metrics: allMetrics};
}

/**
 * Fetch all dynamic templates from SendGrid.
 * @returns {Promise<Array<{id: string, name: string, subject: string, updatedAt: string}>>}
 */
async function getTemplates() {
  const key = await getApiKey();
  const url = "https://api.sendgrid.com/v3/templates?generations=dynamic&page_size=18";
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SendGrid templates API failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return (data.result || []).map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.versions?.find((v) => v.active === 1)?.subject || "",
    updatedAt: t.updated_at || "",
  }));
}

/**
 * Build a simple confirmation email body.
 * @param {Object} opts
 * @param {string} opts.type - 'private_lesson' | 'package' | 'class' | 'event' | 'workshop'
 * @param {Object} opts.details - Type-specific details
 * @returns {{ subject: string, html: string, text: string }}
 */
function buildConfirmationEmail({type, details}) {
  let subject = "Your booking confirmation";
  let bodyLines = [];

  switch (type) {
    case "private_lesson":
      subject = `Private Lesson Confirmed — ${details.instructorName}`;
      bodyLines = [
        `<h2 style="color:#1e293b;margin:0 0 16px">Private Lesson Confirmed!</h2>`,
        `<p>Your private lesson has been booked and payment received. Here are the details:</p>`,
        `<table style="width:100%;border-collapse:collapse;margin:16px 0">`,
        `<tr><td style="padding:8px 0;color:#64748b;width:140px">Instructor</td><td style="padding:8px 0;font-weight:600">${details.instructorName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Studio</td><td style="padding:8px 0">${details.studioName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Date</td><td style="padding:8px 0">${details.date}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Time</td><td style="padding:8px 0">${details.timeSlot}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Amount Paid</td><td style="padding:8px 0;font-weight:600">$${details.amountPaid}</td></tr>`,
        `</table>`,
        `<p style="color:#475569">The studio may reach out to confirm any final details. If you have questions, contact the studio directly.</p>`,
      ];
      break;

    case "package":
      subject = `Package Purchase Confirmed — ${details.packageName}`;
      bodyLines = [
        `<h2 style="color:#1e293b;margin:0 0 16px">Package Purchase Confirmed!</h2>`,
        `<p>Your package has been purchased successfully.</p>`,
        `<table style="width:100%;border-collapse:collapse;margin:16px 0">`,
        `<tr><td style="padding:8px 0;color:#64748b;width:140px">Package</td><td style="padding:8px 0;font-weight:600">${details.packageName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Studio</td><td style="padding:8px 0">${details.studioName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Credits Added</td><td style="padding:8px 0;font-weight:600">${details.creditsAdded}</td></tr>`,
        details.expirationDate ? `<tr><td style="padding:8px 0;color:#64748b">Expires</td><td style="padding:8px 0">${details.expirationDate}</td></tr>` : "",
        `<tr><td style="padding:8px 0;color:#64748b">Amount Paid</td><td style="padding:8px 0;font-weight:600">$${details.amountPaid}</td></tr>`,
        `</table>`,
        `<p style="color:#475569">Your credits are ready to use. Book a class and use credits at checkout.</p>`,
      ];
      break;

    case "class":
      subject = `Class Registration Confirmed — ${details.itemName}`;
      bodyLines = [
        `<h2 style="color:#1e293b;margin:0 0 16px">Class Registration Confirmed!</h2>`,
        `<p>You're registered for the following class:</p>`,
        `<table style="width:100%;border-collapse:collapse;margin:16px 0">`,
        `<tr><td style="padding:8px 0;color:#64748b;width:140px">Class</td><td style="padding:8px 0;font-weight:600">${details.itemName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Studio</td><td style="padding:8px 0">${details.studioName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Amount Paid</td><td style="padding:8px 0;font-weight:600">$${details.amountPaid}</td></tr>`,
        `</table>`,
      ];
      break;

    case "event":
    case "workshop":
      subject = `Registration Confirmed — ${details.itemName}`;
      bodyLines = [
        `<h2 style="color:#1e293b;margin:0 0 16px">Registration Confirmed!</h2>`,
        `<p>You're registered for the following ${type}:</p>`,
        `<table style="width:100%;border-collapse:collapse;margin:16px 0">`,
        `<tr><td style="padding:8px 0;color:#64748b;width:140px">${type === "event" ? "Event" : "Workshop"}</td><td style="padding:8px 0;font-weight:600">${details.itemName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Studio</td><td style="padding:8px 0">${details.studioName}</td></tr>`,
        `<tr><td style="padding:8px 0;color:#64748b">Amount Paid</td><td style="padding:8px 0;font-weight:600">$${details.amountPaid}</td></tr>`,
        `</table>`,
      ];
      break;

    default:
      subject = "Purchase Confirmation";
      bodyLines = [`<p>Thank you for your purchase!</p>`];
  }

  const html = `
    <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#f8fafc">
      <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">
        ${bodyLines.join("\n")}
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
        <p style="color:#94a3b8;font-size:12px;margin:0">
          This is an automated confirmation. Please do not reply to this email.
        </p>
      </div>
    </div>`;

  const text = bodyLines
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join("\n");

  return {subject, html, text};
}

/**
 * Send a purchase / booking confirmation email.
 * @param {string} to - Recipient email address
 * @param {string} type - 'private_lesson' | 'package' | 'class' | 'event' | 'workshop'
 * @param {Object} details - Type-specific detail fields (see buildConfirmationEmail)
 * @returns {Promise<void>}
 */
async function sendConfirmationEmail(to, type, details) {
  if (!to) {
    console.warn("[SendGrid] sendConfirmationEmail: no recipient email, skipping");
    return;
  }

  const {subject, html, text} = buildConfirmationEmail({type, details});

  await sendEmail({
    to,
    from: {email: "info@danceup.app", name: "DanceUp"},
    subject,
    html,
    text,
  });
}

module.exports = {
  sendEmail,
  getApiKey,
  getCategoryStats,
  getTemplates,
  sendConfirmationEmail,
};
