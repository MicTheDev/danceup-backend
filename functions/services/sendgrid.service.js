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

module.exports = {
  sendEmail,
  getApiKey,
  getCategoryStats,
  getTemplates,
};
