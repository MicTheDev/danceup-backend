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
 * Send a welcome email to a newly registered student.
 * @param {string} to - Recipient email address
 * @param {string} firstName - Recipient's first name
 * @returns {Promise<void>}
 */
async function sendWelcomeEmail(to, firstName) {
  if (!to) {
    console.warn("[SendGrid] sendWelcomeEmail: no recipient email, skipping");
    return;
  }

  const name = firstName ? firstName.trim() : "there";

  const html = `
    <div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#f8fafc">
      <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">

        <h1 style="margin:0 0 4px;font-size:26px;color:#1e293b">Welcome to DanceUp, ${name}! 🎉</h1>
        <p style="margin:0 0 24px;color:#64748b;font-size:15px">We're so excited to have you in the community. Here's a quick look at what you can do.</p>

        <div style="background:#f1f5f9;border-radius:10px;padding:20px 24px;margin-bottom:24px">

          <div style="display:flex;align-items:flex-start;margin-bottom:18px">
            <span style="font-size:22px;margin-right:12px;flex-shrink:0">🔍</span>
            <div>
              <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">Browse Classes &amp; Studios</p>
              <p style="margin:0;color:#64748b;font-size:14px">Search for dance classes, explore local studios, and meet the instructors behind them — all filtered by style, city, and skill level.</p>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start;margin-bottom:18px">
            <span style="font-size:22px;margin-right:12px;flex-shrink:0">🎟️</span>
            <div>
              <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">Discover Events &amp; Workshops</p>
              <p style="margin:0;color:#64748b;font-size:14px">Find socials, festivals, congresses, and intensive workshops happening near you. Register and pay directly through DanceUp.</p>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start;margin-bottom:18px">
            <span style="font-size:22px;margin-right:12px;flex-shrink:0">🧑‍🏫</span>
            <div>
              <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">Book Private Lessons</p>
              <p style="margin:0;color:#64748b;font-size:14px">Browse instructor profiles and book one-on-one sessions at studios near you. Perfect for leveling up your technique.</p>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start">
            <span style="font-size:22px;margin-right:12px;flex-shrink:0">📊</span>
            <div>
              <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">Your Dashboard</p>
              <p style="margin:0;color:#64748b;font-size:14px">Head to your dashboard to view your purchase history, manage your profile, check your upcoming bookings, and track any class credits or packages you've bought.</p>
            </div>
          </div>

        </div>

        <a href="https://danceup.app" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px">
          Start Exploring →
        </a>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px"/>
        <p style="color:#94a3b8;font-size:12px;margin:0">
          You're receiving this because you just created a DanceUp account. If this wasn't you, please ignore this email.
        </p>
      </div>
    </div>`;

  const text = [
    `Welcome to DanceUp, ${name}!`,
    ``,
    `Here's what you can do:`,
    ``,
    `Browse Classes & Studios — Search for dance classes, explore local studios, and meet instructors, filtered by style, city, and skill level.`,
    ``,
    `Discover Events & Workshops — Find socials, festivals, congresses, and intensive workshops near you. Register and pay directly through DanceUp.`,
    ``,
    `Book Private Lessons — Browse instructor profiles and book one-on-one sessions at studios near you.`,
    ``,
    `Your Dashboard — View your purchase history, manage your profile, check upcoming bookings, and track class credits or packages.`,
    ``,
    `Start exploring at https://danceup.app`,
  ].join("\n");

  await sendEmail({
    to,
    from: {email: "info@danceup.app", name: "DanceUp"},
    subject: `Welcome to DanceUp, ${name}!`,
    html,
    text,
    categories: ["welcome-email"],
  });
}

/**
 * Send a welcome email to a newly registered studio owner.
 * @param {string} to - Recipient email address
 * @param {string} firstName - Studio owner's first name
 * @param {string} studioName - Name of the studio
 * @returns {Promise<void>}
 */
async function sendStudioOwnerWelcomeEmail(to, firstName, studioName) {
  if (!to) {
    console.warn("[SendGrid] sendStudioOwnerWelcomeEmail: no recipient email, skipping");
    return;
  }

  const name = firstName ? firstName.trim() : "there";
  const studio = studioName ? studioName.trim() : "your studio";

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#f8fafc">
      <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">

        <h1 style="margin:0 0 4px;font-size:26px;color:#1e293b">Welcome to DanceUp, ${name}!</h1>
        <p style="margin:0 0 24px;color:#64748b;font-size:15px">
          <strong>${studio}</strong> is now live on DanceUp. Here's a quick look at everything you can do from your dashboard.
        </p>

        <div style="background:#f1f5f9;border-radius:10px;padding:20px 24px;margin-bottom:24px">

          <div style="margin-bottom:18px">
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">📋 Classes, Workshops &amp; Events</p>
            <p style="margin:0;color:#64748b;font-size:14px">Create and schedule your class catalog, plan one-off workshops and intensives, or organize recitals and showcases. Manage attendees, check-ins, and refunds — all in one place.</p>
          </div>

          <div style="margin-bottom:18px">
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">📦 Packages</p>
            <p style="margin:0;color:#64748b;font-size:14px">Bundle classes into credit packages and offer flexible pricing to your students. Set expiration dates and control how credits are applied at checkout.</p>
          </div>

          <div style="margin-bottom:18px">
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">👩‍🎓 Students &amp; Instructors</p>
            <p style="margin:0;color:#64748b;font-size:14px">View enrollment details, track attendance, and manage student credit balances. Add instructors to your team and manage their profiles and schedules.</p>
          </div>

          <div style="margin-bottom:18px">
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">📊 Analytics &amp; Revenue</p>
            <p style="margin:0;color:#64748b;font-size:14px">Monitor attendance trends, track tuition and package revenue, and read student reviews — all from your Analytics section.</p>
          </div>

          <div style="margin-bottom:18px">
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">📣 Email Marketing</p>
            <p style="margin:0;color:#64748b;font-size:14px">Create and send email campaigns directly to your enrolled students. Track opens, clicks, and engagement from your Marketing dashboard.</p>
          </div>

          <div>
            <p style="margin:0 0 2px;font-weight:600;color:#1e293b;font-size:15px">📲 Check-In Kiosk</p>
            <p style="margin:0;color:#64748b;font-size:14px">Set up an in-person check-in station so students can self-check into classes when they arrive at your studio.</p>
          </div>

        </div>

        <div style="background:#fef9ec;border:1px solid #fcd34d;border-radius:10px;padding:20px 24px;margin-bottom:24px">
          <p style="margin:0 0 6px;font-weight:700;color:#92400e;font-size:15px">⚡ One more step before you can accept payments</p>
          <p style="margin:0 0 14px;color:#78350f;font-size:14px">
            To start collecting tuition, selling packages, and processing registrations, you'll need to connect a Stripe account. Stripe is how DanceUp handles all payouts to your studio — it's free to set up and only takes a few minutes.
          </p>
          <a href="https://studio-owners.danceup.app/register/stripe-setup"
             style="display:inline-block;background:#f59e0b;color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:600;font-size:14px">
            Connect Stripe Now →
          </a>
        </div>

        <a href="https://studio-owners.danceup.app/dashboard"
           style="display:inline-block;background:linear-gradient(135deg,#6366f1,#ec4899);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px">
          Go to Your Dashboard →
        </a>

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px"/>
        <p style="color:#94a3b8;font-size:12px;margin:0">
          You're receiving this because you just created a DanceUp studio account. If this wasn't you, please contact us at <a href="mailto:info@danceup.app" style="color:#94a3b8">info@danceup.app</a>.
        </p>

      </div>
    </div>`;

  const text = [
    `Welcome to DanceUp, ${name}!`,
    ``,
    `${studio} is now live on DanceUp. Here's a quick look at what you can do:`,
    ``,
    `Classes, Workshops & Events — Create and schedule classes, plan workshops and intensives, and organize showcases. Manage attendees, check-ins, and refunds.`,
    ``,
    `Packages — Bundle classes into credit packages with flexible pricing and expiration dates.`,
    ``,
    `Students & Instructors — Track enrollment and attendance, manage student credits, and add instructor profiles.`,
    ``,
    `Analytics & Revenue — Monitor attendance trends, track revenue, and read student reviews.`,
    ``,
    `Email Marketing — Create and send campaigns to your students and track engagement.`,
    ``,
    `Check-In Kiosk — Set up an in-person self-check-in station at your studio.`,
    ``,
    `--- IMPORTANT: Connect Stripe to Accept Payments ---`,
    ``,
    `Before you can collect tuition or sell packages, you need to connect a Stripe account. It's free and only takes a few minutes.`,
    ``,
    `Connect Stripe: https://studio-owners.danceup.app/register/stripe-setup`,
    ``,
    `Go to your dashboard: https://studio-owners.danceup.app/dashboard`,
  ].join("\n");

  await sendEmail({
    to,
    from: {email: "info@danceup.app", name: "DanceUp"},
    subject: `Welcome to DanceUp — let's get ${studio} set up!`,
    html,
    text,
    categories: ["studio-owner-welcome"],
  });
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
  sendWelcomeEmail,
  sendStudioOwnerWelcomeEmail,
};
