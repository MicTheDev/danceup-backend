const {GoogleGenerativeAI} = require("@google/generative-ai");
const {getSecret} = require("../utils/secret-manager");

let cachedClient = null;

/**
 * Get (or lazily initialise) the Gemini client using Secret Manager.
 * @returns {Promise<GoogleGenerativeAI>}
 */
async function getClient() {
  if (cachedClient) return cachedClient;

  const apiKey = await getSecret("gemini-api-key");
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Gemini API key not found in Secret Manager. Add a secret named 'gemini-api-key'.");
  }

  cachedClient = new GoogleGenerativeAI(apiKey.trim());
  return cachedClient;
}

/**
 * Build a human-readable schedule summary to pass into the prompt.
 * @param {Array} classes
 * @param {Array} events
 * @param {Array} workshops
 * @returns {string}
 */
function buildScheduleSummary(classes, events, workshops) {
  const lines = [];

  if (classes.length > 0) {
    lines.push("REGULAR CLASSES:");
    classes.slice(0, 8).forEach((c) => {
      lines.push(`  - ${c.name} | ${c.danceGenre || ""} | ${c.level || ""} | ${c.dayOfWeek || ""} ${c.startTime || ""}–${c.endTime || ""} | $${c.cost ?? ""}`);
    });
  }

  if (events.length > 0) {
    lines.push("\nUPCOMING EVENTS:");
    events.slice(0, 5).forEach((e) => {
      const date = e.startTime ? new Date(e.startTime).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"}) : "";
      const price = e.priceTiers?.[0]?.price != null ? ` | Starting at $${e.priceTiers[0].price}` : "";
      lines.push(`  - ${e.name} | ${e.type || "event"} | ${date}${price}`);
    });
  }

  if (workshops.length > 0) {
    lines.push("\nUPCOMING WORKSHOPS:");
    workshops.slice(0, 5).forEach((w) => {
      const date = w.startTime ? new Date(w.startTime).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"}) : "";
      const price = w.priceTiers?.[0]?.price != null ? ` | Starting at $${w.priceTiers[0].price}` : "";
      const levels = Array.isArray(w.levels) ? w.levels.join(", ") : (w.levels || "");
      lines.push(`  - ${w.name} | ${w.danceGenre || ""} | ${levels} | ${date}${price}`);
    });
  }

  return lines.length > 0 ? lines.join("\n") : "No upcoming schedule found. Create a general promotional email about the studio.";
}

/**
 * Generate an email campaign subject line and HTML body using Gemini AI.
 *
 * @param {Object} opts
 * @param {string} opts.studioName    - The studio's display name
 * @param {Array}  opts.classes       - Active classes for this studio
 * @param {Array}  opts.events        - Upcoming events for this studio
 * @param {Array}  opts.workshops     - Upcoming workshops for this studio
 * @param {string} opts.tone          - 'promotional' | 'informational' | 'community'
 * @param {string} [opts.instructions] - Extra instructions from the studio owner
 * @param {string} [opts.imageUrl]    - Optional image URL to include in the email
 * @returns {Promise<{subject: string, htmlBody: string}>}
 */
async function generateEmailCampaign({studioName, classes, events, workshops, tone, instructions, imageUrl}) {
  const genAI = await getClient();

  const toneMap = {
    promotional: "exciting and promotional — use urgency, enthusiasm, and strong calls to action",
    informational: "clear, professional, and informative — focus on facts, dates, and details",
    community: "warm, friendly, and community-focused — emphasize belonging, passion, and connection",
  };
  const toneDescription = toneMap[tone] || toneMap.community;

  const schedule = buildScheduleSummary(classes, events, workshops);

  const imageSection = imageUrl
    ? `\nIMAGE TO INCLUDE: Place this image prominently below the header gradient section using this exact tag (do not modify the src): <img src="${imageUrl}" alt="${studioName}" style="width:100%;max-width:600px;display:block;border-radius:12px;margin:0 auto 24px;" />`
    : "";

  const customInstructions = instructions && instructions.trim()
    ? `\nADDITIONAL INSTRUCTIONS FROM STUDIO OWNER (follow these carefully): ${instructions.trim()}`
    : "";

  const prompt = `You are an expert email marketing copywriter for dance studios.

Write a marketing email for the dance studio "${studioName}".

Tone: ${toneDescription}

Studio schedule / content to feature:
${schedule}
${imageSection}${customInstructions}

Requirements:
1. Write a compelling subject line — max 60 characters, specific to the content
2. Write a complete, visually polished HTML email body using ONLY inline styles (no <style> tags, no external CSS, no <html>/<head>/<body> tags — just the inner content div)
3. Design constraints:
   - Max content width: 600px centered with margin: 0 auto
   - Primary color: #6366f1 (indigo)
   - Accent color: #ec4899 (pink)
   - Background: #f8fafc
   - White card sections with border-radius: 12px and subtle box-shadow
4. Structure:
   - Header section: studio name + compelling headline with a gradient (use background: linear-gradient(135deg, #6366f1, #ec4899))
   - If an image was provided above, place it immediately after the header section
   - Content sections: clearly list each class/event/workshop with name, date/time, price, and a short enticing description
   - One clear CTA button linking to "#" styled with the primary color
   - Footer: small gray unsubscribe placeholder text
5. Make it mobile-friendly with responsive inline styles
6. Use real content from the schedule above — do not invent fake class names

Return ONLY a valid JSON object with exactly these two keys (no markdown fences, no extra text):
{"subject": "subject line here", "htmlBody": "complete html string here"}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.8,
    },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    // Strip accidental markdown code fences if the model adds them despite instructions
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[AI] Failed to parse Gemini response:", text.slice(0, 200));
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.subject || !parsed.htmlBody) {
    throw new Error("AI response was missing required fields. Please try again.");
  }

  return {
    subject: String(parsed.subject).trim(),
    htmlBody: String(parsed.htmlBody).trim(),
  };
}

/**
 * Generate a short description for a class, workshop, event, or package.
 *
 * @param {'class'|'workshop'|'event'|'package'} type
 * @param {Object} context - Relevant form fields for the item
 * @returns {Promise<{description: string}>}
 */
async function generateDescription(type, context) {
  const genAI = await getClient();

  const validTypes = ["class", "workshop", "event", "package"];
  if (!validTypes.includes(type)) throw new Error("Invalid content type");

  let typeName = "";
  let contextLines = [];

  if (type === "class") {
    typeName = "dance class";
    contextLines = [
      context.name && `Name: ${context.name}`,
      context.danceGenre && `Dance genre: ${context.danceGenre}`,
      context.level && `Level: ${context.level}`,
      context.dayOfWeek && `Day: ${context.dayOfWeek}`,
      context.startTime && context.endTime && `Time: ${context.startTime}–${context.endTime}`,
      context.cost != null && `Cost: $${context.cost} per class`,
      context.maxCapacity && `Max capacity: ${context.maxCapacity} students`,
      context.room && `Room: ${context.room}`,
    ];
  } else if (type === "workshop") {
    typeName = "dance workshop";
    const dateStr = context.startTime
      ? new Date(context.startTime).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"})
      : "";
    const levels = Array.isArray(context.levels) ? context.levels.join(", ") : (context.levels || "");
    contextLines = [
      context.name && `Name: ${context.name}`,
      context.danceGenre && `Dance genre: ${context.danceGenre}`,
      levels && `Levels: ${levels}`,
      dateStr && `Date: ${dateStr}`,
      context.locationName && `Venue: ${context.locationName}`,
      context.city && context.state && `City: ${context.city}, ${context.state}`,
    ];
  } else if (type === "event") {
    typeName = "dance event";
    const dateStr = context.startTime
      ? new Date(context.startTime).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"})
      : "";
    contextLines = [
      context.name && `Name: ${context.name}`,
      context.type && `Event type: ${context.type}`,
      context.danceGenre && `Dance genre: ${context.danceGenre}`,
      dateStr && `Date: ${dateStr}`,
      context.locationName && `Venue: ${context.locationName}`,
      context.city && context.state && `City: ${context.city}, ${context.state}`,
    ];
  } else if (type === "package") {
    typeName = "class package";
    const billingNote = context.isRecurring
      ? `Recurring billing: ${context.billingFrequencyType || "monthly"}`
      : `One-time purchase, valid for ${context.expirationDays || "?"} days`;
    contextLines = [
      context.name && `Name: ${context.name}`,
      context.price != null && `Price: $${context.price}`,
      context.credits != null && `Credits: ${context.credits} class credits`,
      billingNote,
      context.classNames && context.classNames.length > 0 && `Included classes: ${context.classNames.join(", ")}`,
    ];
  }

  const contextSummary = contextLines.filter(Boolean).join("\n");
  if (!contextSummary.trim()) {
    throw new Error("Please fill in at least the name and a few fields before generating a description.");
  }

  const prompt = `You are a copywriter for a dance studio management platform.

Write a concise, engaging description for the following ${typeName}:

${contextSummary}

Requirements:
- 2–4 sentences maximum
- Enthusiastic but professional tone
- Highlight the key details (genre, level, what students will get out of it, etc.)
- Written from the studio's perspective — use phrases like "this class", "join us", "students will", "participants will"
- Do NOT invent details not present above
- Do NOT repeat pricing or scheduling as the main focus — that info lives elsewhere in the form

Return ONLY a valid JSON object with exactly one key (no markdown fences, no extra text):
{"description": "the description text here"}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("[AI] Failed to parse Gemini response:", text.slice(0, 200));
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.description) {
    throw new Error("AI response was missing the description field. Please try again.");
  }

  return {description: String(parsed.description).trim()};
}

/**
 * Generate plain-English studio performance insights from dashboard + class attendance data.
 * @param {{ studioName: string, dashboardStats: Object, topClasses: Array }} data
 * @returns {Promise<{insights: string, highlights: string[]}>}
 */
async function generateStudioInsights({studioName, dashboardStats, topClasses}) {
  const genAI = await getClient();

  const ds = dashboardStats;
  const pulse = (ds.attendancePulse || []).map((p) =>
    `${p.day}: ${p.checkIns} check-ins / ${p.fillRate}% fill`).join(", ");

  const classLines = topClasses.length > 0
    ? topClasses.map((c) => `  - ${c.name}: ${c.totalAttendance} check-ins`).join("\n")
    : "  No class attendance data available.";

  const contextBlock = `Studio: ${studioName}

KEY METRICS (vs prior period):
- Active students this month: ${ds.activeStudents?.current ?? "N/A"} (${ds.activeStudents?.change >= 0 ? "+" : ""}${ds.activeStudents?.change ?? 0}% vs last month)
- Check-ins this week: ${ds.avgAttendance?.current ?? "N/A"} (${ds.avgAttendance?.change >= 0 ? "+" : ""}${ds.avgAttendance?.change ?? 0}% vs last week)
- New sign-ups this week: ${ds.newSignups?.current ?? "N/A"} (${ds.newSignups?.change >= 0 ? "+" : ""}${ds.newSignups?.change ?? 0}% vs last week)
- Monthly revenue: $${ds.monthlyRevenue?.current ?? "N/A"} (${ds.monthlyRevenue?.change >= 0 ? "+" : ""}${ds.monthlyRevenue?.change ?? 0}% vs last month)

7-DAY ATTENDANCE PULSE:
${pulse || "No data"}

TOP CLASSES BY ATTENDANCE (last 30 days):
${classLines}`;

  const prompt = `You are a studio performance analyst helping a dance studio owner understand their business.

Analyze the following data and provide actionable insights:

${contextBlock}

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "insights": "2-3 sentence paragraph summarizing overall performance, what's going well, and what needs attention",
  "highlights": ["3 to 5 short bullet points — use ✅ for positive, ⚠️ for warning, 💡 for opportunity, each max 15 words"]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.insights || !Array.isArray(parsed.highlights)) {
    throw new Error("AI response was missing required fields. Please try again.");
  }

  return {
    insights: String(parsed.insights).trim(),
    highlights: parsed.highlights.map((h) => String(h).trim()),
  };
}

/**
 * Generate a plain-English engagement summary from student activity data.
 * @param {{ stats: Object }} data
 * @returns {Promise<{summary: string}>}
 */
async function generateEngagementSummary({stats}) {
  const genAI = await getClient();

  const contextBlock = `Student Engagement Snapshot:
- Total students: ${stats.totalStudents}
- Active this month (at least 1 check-in): ${stats.activeThisMonth}
- At-risk students (30+ days inactive): ${stats.atRiskCount} (${stats.totalStudents > 0 ? Math.round((stats.atRiskCount / stats.totalStudents) * 100) : 0}% of roster)
- At-risk students with unused credits: ${stats.atRiskWithCredits}
- Average check-ins per active student this month: ${stats.avgCheckInsPerActiveStudent}
- Students with credit balances: ${stats.studentsWithCredits}`;

  const prompt = `You are a student retention analyst for a dance studio.

Analyze the following engagement data and write a short, actionable summary for the studio owner:

${contextBlock}

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "summary": "2-3 sentences — describe the engagement health, flag churn risk, and suggest one concrete re-engagement action the owner can take today"
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.summary) {
    throw new Error("AI response was missing required fields. Please try again.");
  }

  return {summary: String(parsed.summary).trim()};
}

/**
 * Suggest up to 3 available class time slots based on existing schedule and a natural-language request.
 * @param {{ studioName: string, existingSchedule: string, attendancePulse: string, request: string }} data
 * @returns {Promise<{suggestions: Array<{dayOfWeek,startTime,endTime,room,reasoning}>}>}
 */
async function generateSchedulingSuggestions({studioName, existingSchedule, attendancePulse, request}) {
  const genAI = await getClient();

  const prompt = `You are a dance studio scheduling assistant for "${studioName}".

The studio owner wants to add a new class. Here is their request:
"${request}"

EXISTING CLASS SCHEDULE (do NOT overlap with these times/rooms):
${existingSchedule || "No existing classes."}

7-DAY ATTENDANCE PULSE (shows which days/times are currently busiest):
${attendancePulse || "No attendance data."}

Based on the above, suggest exactly 3 available time slots that:
1. Do NOT conflict with existing classes in the same room
2. Prefer times and days that complement existing attendance patterns
3. Consider typical dance class durations (45–90 minutes)
4. If a room name can be inferred from existing classes, use it; otherwise suggest "Main Studio"

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "suggestions": [
    {
      "dayOfWeek": "Monday",
      "startTime": "19:00",
      "endTime": "20:00",
      "room": "Main Studio",
      "reasoning": "Short explanation of why this slot works well"
    }
  ]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.5},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
    throw new Error("AI response was missing suggestions. Please try again.");
  }

  return {suggestions: parsed.suggestions.slice(0, 3)};
}

/**
 * Generate a professional, personalized review response for a studio owner.
 * @param {{ studioName: string, rating: number, comment: string, entityType: string, entityName: string }} data
 * @returns {Promise<{suggestedResponse: string}>}
 */
async function generateReviewResponse({studioName, rating, comment, entityType, entityName}) {
  const genAI = await getClient();

  const entityLabel = entityType === "studio" ? studioName
    : entityType === "class" ? `the class "${entityName}"`
    : `instructor ${entityName}`;

  const sentiment = rating >= 4 ? "positive" : rating === 3 ? "neutral/mixed" : "negative/critical";

  const prompt = `You are a professional community manager for "${studioName}", a dance studio.

A student left a ${sentiment} review (${rating}/5 stars) about ${entityLabel}:
"${comment || "(No written comment — just a star rating)"}"

Write a warm, professional response the studio owner can send back. Guidelines:
- For positive reviews (4–5 stars): express genuine gratitude, reinforce what they liked, invite them back
- For neutral reviews (3 stars): acknowledge feedback graciously, show commitment to improvement, stay positive
- For negative/critical reviews (1–2 stars): remain professional and empathetic, do NOT be defensive, acknowledge their experience, offer to resolve offline if needed
- Keep it concise: 2–4 sentences maximum
- Do NOT invent promises or specific offers unless generic (e.g., "we'd love to chat")
- Sound human — avoid corporate-speak

Return ONLY a valid JSON object (no markdown, no extra text):
{"suggestedResponse": "the response text here"}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.6},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.suggestedResponse) {
    throw new Error("AI response was missing the suggested response. Please try again.");
  }

  return {suggestedResponse: String(parsed.suggestedResponse).trim()};
}

/**
 * Generate package pricing recommendations based on purchase data and class fill rates.
 * @param {{ studioName: string, packagesContext: string, purchaseContext: string, classContext: string }} data
 * @returns {Promise<{overallInsight: string, recommendations: Array}>}
 */
async function generatePackageRecommendations({studioName, packagesContext, purchaseContext, classContext}) {
  const genAI = await getClient();

  const prompt = `You are a pricing analyst for "${studioName}", a dance studio.

CURRENT PACKAGES:
${packagesContext || "No packages configured."}

PURCHASE DATA (last 90 days):
${purchaseContext || "No purchase data available."}

CLASS FILL RATES (last 7 days):
${classContext || "No class data available."}

Analyze this data and provide actionable pricing recommendations. Consider:
- Are any packages not selling? (could be priced too high, or credits/value unclear)
- Are popular classes consistently full? (could justify a premium package)
- Credit-to-price ratio — is the value proposition clear?
- Suggest a new package tier only if there is an obvious gap (e.g., students needing more or fewer credits)

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "overallInsight": "2–3 sentence summary of the pricing health",
  "recommendations": [
    {
      "packageId": "id or null if new package suggestion",
      "packageName": "package name",
      "currentPrice": 0,
      "type": "increase_price | decrease_price | adjust_credits | adjust_expiration | new_package | no_change",
      "suggestion": "One clear action the owner should consider",
      "reasoning": "1–2 sentence explanation using the data above"
    }
  ]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.overallInsight || !Array.isArray(parsed.recommendations)) {
    throw new Error("AI response was missing required fields. Please try again.");
  }

  return {
    overallInsight: String(parsed.overallInsight).trim(),
    recommendations: parsed.recommendations,
  };
}

/**
 * Generate a personalized re-engagement email for an at-risk student.
 * @param {{ studioName: string, studentName: string, daysSince: number|null, neverAttended: boolean, unusedCredits: number, lastClasses: string[], upcomingHighlights: string[] }} data
 * @returns {Promise<{subject: string, body: string}>}
 */
async function generateReEngagementEmail({studioName, studentName, daysSince, neverAttended, unusedCredits, lastClasses, upcomingHighlights}) {
  const genAI = await getClient();

  const attendanceContext = neverAttended
    ? `${studentName} enrolled but has never attended a class.`
    : `${studentName} hasn't attended in ${daysSince} days.`;
  const creditsNote = unusedCredits > 0 ? `They have ${unusedCredits} unused credit${unusedCredits !== 1 ? "s" : ""} that will expire if unused.` : "";
  const lastClassesNote = lastClasses.length > 0 ? `Their recent classes: ${lastClasses.join(", ")}.` : "";
  const upcomingNote = upcomingHighlights.length > 0 ? `Upcoming at the studio: ${upcomingHighlights.join("; ")}.` : "";

  const prompt = `You are writing a warm, personal re-engagement email on behalf of "${studioName}" to a student named ${studentName}.

Context:
- ${attendanceContext}
- ${creditsNote}
- ${lastClassesNote}
- ${upcomingNote}

Write a short, genuine re-engagement email. Guidelines:
- Friendly and personal, not salesy
- Acknowledge the absence without guilt-tripping
- Mention unused credits if they have them (create urgency without pressure)
- Reference a relevant upcoming class or event if available
- End with an easy call to action (e.g., "We'd love to see you back")
- Subject line: max 50 characters, personal and curiosity-driven

Return ONLY a valid JSON object (no markdown, no extra text):
{"subject": "subject line", "body": "email body text (plain text, no HTML, 3–5 short paragraphs)"}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.7},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.subject || !parsed.body) throw new Error("AI response was missing required fields.");
  return {subject: String(parsed.subject).trim(), body: String(parsed.body).trim()};
}

/**
 * Generate instructor performance summaries.
 * @param {{ studioName: string, instructors: Array }} data
 * @returns {Promise<{summary: string, instructorInsights: Array<{name, highlights: string[]}>}>}
 */
async function generateInstructorPerformance({studioName, instructors}) {
  const genAI = await getClient();

  const instructorLines = instructors.map((i) => {
    const avgRating = i.avgRating ? ` | Avg review: ${i.avgRating}/5 (${i.reviewCount} review${i.reviewCount !== 1 ? "s" : ""})` : " | No reviews yet";
    return `  - ${i.name}: ${i.classCount} class${i.classCount !== 1 ? "es" : ""} | ${i.totalCheckIns} total check-ins last 30 days | Avg fill rate: ${i.avgFillRate}%${avgRating}`;
  }).join("\n");

  const prompt = `You are a performance analyst for "${studioName}", a dance studio.

Analyze the following instructor data and provide actionable insights for the studio owner:

INSTRUCTOR DATA (last 30 days):
${instructorLines || "No instructor data available."}

Requirements:
- Write a 2–3 sentence overall summary
- For each instructor, list 2–3 concise bullet highlights using ✅ for strengths and ⚠️ for areas to watch

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "summary": "overall summary paragraph",
  "instructorInsights": [
    {"name": "instructor name", "highlights": ["✅ ...", "⚠️ ..."]}
  ]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary || !Array.isArray(parsed.instructorInsights)) throw new Error("AI response was missing required fields.");
  return {summary: String(parsed.summary).trim(), instructorInsights: parsed.instructorInsights};
}

/**
 * Generate a student progress report.
 * @param {{ studioName: string, studentName: string, totalCheckIns: number, checkIns30Days: number, uniqueClasses: number, classNames: string[], memberSince: string, credits: number }} data
 * @returns {Promise<{report: string}>}
 */
async function generateStudentProgressReport({studioName, studentName, totalCheckIns, checkIns30Days, uniqueClasses, classNames, memberSince, credits}) {
  const genAI = await getClient();

  const prompt = `You are writing a student progress report on behalf of "${studioName}" for the student ${studentName}.

STUDENT DATA:
- Member since: ${memberSince}
- Total check-ins (all time): ${totalCheckIns}
- Check-ins this month: ${checkIns30Days}
- Unique classes explored: ${uniqueClasses}
- Classes attended: ${classNames.length > 0 ? classNames.join(", ") : "None recorded"}
- Current credit balance: ${credits}

Write a warm, encouraging 3–4 paragraph progress report that a studio owner could email directly to the student. Include:
1. A welcoming acknowledgment of their journey
2. Highlights of their commitment/attendance
3. Recognition of variety (if they've tried multiple classes) or consistency (if they're loyal to one)
4. Encouragement to keep going / try something new

Write in second person ("You've been..."). Sound personal, not generic.

Return ONLY a valid JSON object (no markdown, no extra text):
{"report": "full report text as plain paragraphs separated by \\n\\n"}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.7},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.report) throw new Error("AI response was missing the report field.");
  return {report: String(parsed.report).trim()};
}

/**
 * Generate class demand analysis.
 * @param {{ studioName: string, classes: Array }} data
 * @returns {Promise<{summary: string, classes: Array<{classId, name, status, action, reasoning}>}>}
 */
async function generateClassDemandAnalysis({studioName, classes}) {
  const genAI = await getClient();

  const classLines = classes.map((c) =>
    `  - [${c.classId}] "${c.name}" | ${c.genre} | ${c.level} | ${c.dayOfWeek} ${c.startTime} | Capacity: ${c.maxCapacity} | Fill rate: ${c.fillRate}% | Check-ins last 30 days: ${c.checkIns}`
  ).join("\n");

  const prompt = `You are a class performance analyst for "${studioName}", a dance studio.

CURRENT CLASS DATA (last 30 days):
${classLines || "No class data available."}

Analyze demand and provide actionable recommendations. For each class:
- Fill rate >80%: consider adding a second session or expanding capacity
- Fill rate 50–80%: healthy, monitor
- Fill rate 20–50%: needs attention — marketing, time change, or promotion
- Fill rate <20%: at risk — consider restructuring or discontinuing

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "summary": "2–3 sentence overall demand health summary",
  "classes": [
    {
      "classId": "id",
      "name": "class name",
      "status": "thriving | healthy | needs_attention | at_risk",
      "action": "one concrete recommended action",
      "reasoning": "brief data-driven explanation"
    }
  ]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary || !Array.isArray(parsed.classes)) throw new Error("AI response was missing required fields.");
  return {summary: String(parsed.summary).trim(), classes: parsed.classes};
}

/**
 * Generate promotional copy for an event or workshop.
 * @param {{ studioName: string, entity: Object, entityType: string }} data
 * @returns {Promise<{instagram: string, facebook: string, emailSubject: string, promoblurb: string}>}
 */
async function generatePromoCopy({studioName, entity, entityType}) {
  const genAI = await getClient();

  const dateStr = entity.startTime ? new Date(entity.startTime).toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"}) : "TBD";
  const price = entity.priceTiers?.[0]?.price != null ? `Starting at $${entity.priceTiers[0].price}` : (entity.cost != null ? `$${entity.cost}` : "Price TBD");
  const levels = Array.isArray(entity.levels) ? entity.levels.join(", ") : (entity.level || "All Levels");
  const location = entity.locationName || studioName;

  const prompt = `You are a social media and marketing copywriter for "${studioName}", a dance studio.

Create promotional copy for the following ${entityType}:
- Name: ${entity.name}
- Type: ${entityType}${entity.type ? ` (${entity.type})` : ""}
- Date: ${dateStr}
- Dance genre: ${entity.danceGenre || "Various"}
- Levels: ${levels}
- Price: ${price}
- Location: ${location}
- Description: ${entity.description || "No description provided"}

Generate 4 pieces of promotional copy:
1. Instagram caption: 2–3 sentences + 5–8 relevant hashtags, energetic and visual
2. Facebook post: 3–4 sentences, more detail-oriented, friendly community tone
3. Email subject line: max 55 characters, create urgency/excitement
4. Short promo blurb: 1–2 sentences for newsletters or event listings

Return ONLY a valid JSON object (no markdown, no extra text):
{"instagram": "...", "facebook": "...", "emailSubject": "...", "promoBlurb": "..."}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.8},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.instagram || !parsed.facebook || !parsed.emailSubject || !parsed.promoBlurb) {
    throw new Error("AI response was missing required fields.");
  }
  return {
    instagram: String(parsed.instagram).trim(),
    facebook: String(parsed.facebook).trim(),
    emailSubject: String(parsed.emailSubject).trim(),
    promoBlurb: String(parsed.promoBlurb).trim(),
  };
}

/**
 * Generate a revenue forecast for the next month.
 * @param {{ studioName: string, monthlyRevenue: Array<{month, revenue}>, activeSubscriptions: number, avgMonthlyGrowth: number }} data
 * @returns {Promise<{forecast: string, projectedRevenue: {low, mid, high}, drivers: string[], risks: string[]}>}
 */
async function generateRevenueForecast({studioName, monthlyRevenue, activeSubscriptions, avgMonthlyGrowth}) {
  const genAI = await getClient();

  const revenueLines = monthlyRevenue.map((m) => `  ${m.month}: $${m.revenue.toFixed(2)}`).join("\n");

  const prompt = `You are a financial analyst for "${studioName}", a dance studio.

REVENUE HISTORY (last 6 months):
${revenueLines || "No historical data available."}

Active recurring subscriptions: ${activeSubscriptions}
Average month-over-month growth: ${avgMonthlyGrowth > 0 ? "+" : ""}${avgMonthlyGrowth}%

Based on this data, forecast next month's revenue. Provide:
1. A 2–3 sentence narrative forecast
2. A low/mid/high revenue range (numbers only, no $ symbol in JSON)
3. 2–3 key revenue drivers
4. 1–2 risks to watch

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "forecast": "narrative paragraph",
  "projectedRevenue": {"low": 0, "mid": 0, "high": 0},
  "drivers": ["driver 1", "driver 2"],
  "risks": ["risk 1"]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.3},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.forecast || !parsed.projectedRevenue) throw new Error("AI response was missing required fields.");
  return {
    forecast: String(parsed.forecast).trim(),
    projectedRevenue: parsed.projectedRevenue,
    drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
  };
}

/**
 * Generate a class schedule health report.
 * @param {{ studioName: string, scheduleContext: string, coverageGaps: string }} data
 * @returns {Promise<{summary: string, strengths: string[], gaps: string[], recommendations: string[]}>}
 */
async function generateScheduleHealth({studioName, scheduleContext, coverageGaps}) {
  const genAI = await getClient();

  const prompt = `You are a studio operations consultant for "${studioName}", a dance studio.

CURRENT SCHEDULE:
${scheduleContext || "No schedule data available."}

COVERAGE ANALYSIS:
${coverageGaps || "No gap analysis available."}

Evaluate the overall schedule health. Consider:
- Day/time coverage (are there dead zones or overcrowded days?)
- Genre and level diversity (beginner-friendly entry points, advanced options)
- Underperforming vs thriving time slots
- Opportunities to fill gaps

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "summary": "2–3 sentence overall health assessment",
  "strengths": ["2–3 things the schedule does well"],
  "gaps": ["2–3 identified weaknesses or gaps"],
  "recommendations": ["3–5 specific, actionable recommendations"]
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {responseMimeType: "application/json", temperature: 0.4},
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary || !Array.isArray(parsed.strengths)) throw new Error("AI response was missing required fields.");
  return {
    summary: String(parsed.summary).trim(),
    strengths: parsed.strengths,
    gaps: parsed.gaps || [],
    recommendations: parsed.recommendations || [],
  };
}

module.exports = {
  generateEmailCampaign,
  generateDescription,
  generateStudioInsights,
  generateEngagementSummary,
  generateSchedulingSuggestions,
  generateReviewResponse,
  generatePackageRecommendations,
  generateReEngagementEmail,
  generateInstructorPerformance,
  generateStudentProgressReport,
  generateClassDemandAnalysis,
  generatePromoCopy,
  generateRevenueForecast,
  generateScheduleHealth,
};
