import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSecret } from "../utils/secret-manager";

let cachedClient: GoogleGenerativeAI | null = null;

async function getClient(): Promise<GoogleGenerativeAI> {
  if (cachedClient) return cachedClient;
  const apiKey = await getSecret("gemini-api-key");
  if (!apiKey || !apiKey.trim()) {
    throw new Error("Gemini API key not found in Secret Manager. Add a secret named 'gemini-api-key'.");
  }
  cachedClient = new GoogleGenerativeAI(apiKey.trim());
  return cachedClient;
}

interface ContentItem {
  name?: string;
  danceGenre?: string;
  level?: string;
  levels?: string | string[];
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  cost?: number;
  type?: string;
  priceTiers?: Array<{ price?: number }>;
  [key: string]: unknown;
}

function buildScheduleSummary(classes: ContentItem[], events: ContentItem[], workshops: ContentItem[]): string {
  const lines: string[] = [];

  if (classes.length > 0) {
    lines.push("REGULAR CLASSES:");
    classes.slice(0, 8).forEach((c) => {
      lines.push(`  - ${c.name} | ${c.danceGenre || ""} | ${c.level || ""} | ${c.dayOfWeek || ""} ${c.startTime || ""}–${c.endTime || ""} | $${c.cost ?? ""}`);
    });
  }

  if (events.length > 0) {
    lines.push("\nUPCOMING EVENTS:");
    events.slice(0, 5).forEach((e) => {
      const date = e.startTime ? new Date(e.startTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
      const price = e.priceTiers?.[0]?.price != null ? ` | Starting at $${e.priceTiers[0].price}` : "";
      lines.push(`  - ${e.name} | ${e.type || "event"} | ${date}${price}`);
    });
  }

  if (workshops.length > 0) {
    lines.push("\nUPCOMING WORKSHOPS:");
    workshops.slice(0, 5).forEach((w) => {
      const date = w.startTime ? new Date(w.startTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
      const price = w.priceTiers?.[0]?.price != null ? ` | Starting at $${w.priceTiers[0].price}` : "";
      const levels = Array.isArray(w.levels) ? w.levels.join(", ") : (w.levels || "");
      lines.push(`  - ${w.name} | ${w.danceGenre || ""} | ${levels} | ${date}${price}`);
    });
  }

  return lines.length > 0 ? lines.join("\n") : "No upcoming schedule found. Create a general promotional email about the studio.";
}

function parseAiResponse<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  return JSON.parse(cleaned) as T;
}

interface EmailCampaignOpts {
  studioName: string;
  classes: ContentItem[];
  events: ContentItem[];
  workshops: ContentItem[];
  tone: string;
  instructions?: string;
  imageUrl?: string;
}

export async function generateEmailCampaign(opts: EmailCampaignOpts): Promise<{ subject: string; htmlBody: string }> {
  const { studioName, classes, events, workshops, tone, instructions, imageUrl } = opts;
  const genAI = await getClient();

  const toneMap: Record<string, string> = {
    promotional: "exciting and promotional — use urgency, enthusiasm, and strong calls to action",
    informational: "clear, professional, and informative — focus on facts, dates, and details",
    community: "warm, friendly, and community-focused — emphasize belonging, passion, and connection",
  };
  const toneDescription = toneMap[tone] || (toneMap["community"] as string);
  const schedule = buildScheduleSummary(classes, events, workshops);
  const imageSection = imageUrl
    ? `\nIMAGE TO INCLUDE: Place this image prominently below the header gradient section using this exact tag (do not modify the src): <img src="${imageUrl}" alt="${studioName}" style="width:100%;max-width:600px;display:block;border-radius:12px;margin:0 auto 24px;" />`
    : "";
  const customInstructions = instructions?.trim()
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
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed: { subject?: string; htmlBody?: string };
  try {
    parsed = parseAiResponse<{ subject?: string; htmlBody?: string }>(text);
  } catch {
    console.error("[AI] Failed to parse Gemini response:", text.slice(0, 200));
    throw new Error("AI returned an unexpected response format. Please try again.");
  }

  if (!parsed.subject || !parsed.htmlBody) throw new Error("AI response was missing required fields. Please try again.");
  return { subject: String(parsed.subject).trim(), htmlBody: String(parsed.htmlBody).trim() };
}

interface DescriptionContext {
  name?: string;
  danceGenre?: string;
  level?: string;
  levels?: string | string[];
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  cost?: number;
  maxCapacity?: number;
  room?: string;
  type?: string;
  locationName?: string;
  city?: string;
  state?: string;
  price?: number;
  credits?: number;
  expirationDays?: number;
  isRecurring?: boolean;
  billingFrequencyType?: string;
  classNames?: string[];
  [key: string]: unknown;
}

export async function generateDescription(
  type: "class" | "workshop" | "event" | "package",
  context: DescriptionContext,
): Promise<{ description: string }> {
  const genAI = await getClient();
  const validTypes = ["class", "workshop", "event", "package"];
  if (!validTypes.includes(type)) throw new Error("Invalid content type");

  let typeName = "";
  let contextLines: Array<string | false | undefined> = [];

  if (type === "class") {
    typeName = "dance class";
    contextLines = [
      context.name && `Name: ${context.name}`,
      context.danceGenre && `Dance genre: ${context.danceGenre}`,
      context.level && `Level: ${context.level}`,
      context.dayOfWeek && `Day: ${context.dayOfWeek}`,
      context.startTime && context.endTime && `Time: ${context.startTime}–${context.endTime}`,
      context.cost != null ? `Cost: $${context.cost} per class` : undefined,
      context.maxCapacity != null ? `Max capacity: ${context.maxCapacity} students` : undefined,
      context.room ? `Room: ${context.room}` : undefined,
    ];
  } else if (type === "workshop") {
    typeName = "dance workshop";
    const dateStr = context.startTime
      ? new Date(context.startTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
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
      ? new Date(context.startTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
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
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { description?: string };
  try {
    parsed = parseAiResponse<{ description?: string }>(text);
  } catch {
    console.error("[AI] Failed to parse Gemini response:", text.slice(0, 200));
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.description) throw new Error("AI response was missing the description field. Please try again.");
  return { description: String(parsed.description).trim() };
}

interface InsightsData {
  studioName: string;
  dashboardStats: Record<string, unknown>;
  topClasses: Array<{ name: string; totalAttendance: number }>;
}

export async function generateStudioInsights(data: InsightsData): Promise<{ insights: string; highlights: string[] }> {
  const genAI = await getClient();
  const { studioName, dashboardStats: ds, topClasses } = data;

  const pulse = ((ds["attendancePulse"] as Array<{ day: string; checkIns: number; fillRate: number }>) || [])
    .map((p) => `${p.day}: ${p.checkIns} check-ins / ${p.fillRate}% fill`).join(", ");

  const active = ds["activeStudents"] as { current?: number; change?: number } | undefined;
  const avg = ds["avgAttendance"] as { current?: number; change?: number } | undefined;
  const signups = ds["newSignups"] as { current?: number; change?: number } | undefined;
  const revenue = ds["monthlyRevenue"] as { current?: number; change?: number } | undefined;

  const classLines = topClasses.length > 0
    ? topClasses.map((c) => `  - ${c.name}: ${c.totalAttendance} check-ins`).join("\n")
    : "  No class attendance data available.";

  const contextBlock = `Studio: ${studioName}

KEY METRICS (vs prior period):
- Active students this month: ${active?.current ?? "N/A"} (${(active?.change ?? 0) >= 0 ? "+" : ""}${active?.change ?? 0}% vs last month)
- Check-ins this week: ${avg?.current ?? "N/A"} (${(avg?.change ?? 0) >= 0 ? "+" : ""}${avg?.change ?? 0}% vs last week)
- New sign-ups this week: ${signups?.current ?? "N/A"} (${(signups?.change ?? 0) >= 0 ? "+" : ""}${signups?.change ?? 0}% vs last week)
- Monthly revenue: $${revenue?.current ?? "N/A"} (${(revenue?.change ?? 0) >= 0 ? "+" : ""}${revenue?.change ?? 0}% vs last month)

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { insights?: string; highlights?: string[] };
  try {
    parsed = parseAiResponse<{ insights?: string; highlights?: string[] }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.insights || !Array.isArray(parsed.highlights)) throw new Error("AI response was missing required fields. Please try again.");
  return { insights: String(parsed.insights).trim(), highlights: parsed.highlights.map((h) => String(h).trim()) };
}

export async function generateEngagementSummary(data: { stats: Record<string, unknown> }): Promise<{ summary: string }> {
  const genAI = await getClient();
  const { stats } = data;

  const contextBlock = `Student Engagement Snapshot:
- Total students: ${stats["totalStudents"]}
- Active this month (at least 1 check-in): ${stats["activeThisMonth"]}
- At-risk students (30+ days inactive): ${stats["atRiskCount"]} (${(stats["totalStudents"] as number) > 0 ? Math.round(((stats["atRiskCount"] as number) / (stats["totalStudents"] as number)) * 100) : 0}% of roster)
- At-risk students with unused credits: ${stats["atRiskWithCredits"]}
- Average check-ins per active student this month: ${stats["avgCheckInsPerActiveStudent"]}
- Students with credit balances: ${stats["studentsWithCredits"]}`;

  const prompt = `You are a student retention analyst for a dance studio.

Analyze the following engagement data and write a short, actionable summary for the studio owner:

${contextBlock}

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "summary": "2-3 sentences — describe the engagement health, flag churn risk, and suggest one concrete re-engagement action the owner can take today"
}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { summary?: string };
  try {
    parsed = parseAiResponse<{ summary?: string }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary) throw new Error("AI response was missing required fields. Please try again.");
  return { summary: String(parsed.summary).trim() };
}

interface SchedulingSuggestionsData {
  studioName: string;
  existingSchedule: string;
  attendancePulse: string;
  request: string;
}

interface SchedulingSuggestion {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  room: string;
  reasoning: string;
}

export async function generateSchedulingSuggestions(data: SchedulingSuggestionsData): Promise<{ suggestions: SchedulingSuggestion[] }> {
  const genAI = await getClient();
  const { studioName, existingSchedule, attendancePulse, request } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { suggestions?: SchedulingSuggestion[] };
  try {
    parsed = parseAiResponse<{ suggestions?: SchedulingSuggestion[] }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) {
    throw new Error("AI response was missing suggestions. Please try again.");
  }
  return { suggestions: parsed.suggestions.slice(0, 3) };
}

interface ReviewResponseData {
  studioName: string;
  rating: number;
  comment: string;
  entityType: string;
  entityName: string;
}

export async function generateReviewResponse(data: ReviewResponseData): Promise<{ suggestedResponse: string }> {
  const genAI = await getClient();
  const { studioName, rating, comment, entityType, entityName } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.6 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { suggestedResponse?: string };
  try {
    parsed = parseAiResponse<{ suggestedResponse?: string }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.suggestedResponse) throw new Error("AI response was missing the suggested response. Please try again.");
  return { suggestedResponse: String(parsed.suggestedResponse).trim() };
}

interface PackageRecommendationsData {
  studioName: string;
  packagesContext: string;
  purchaseContext: string;
  classContext: string;
}

interface PackageRecommendation {
  packageId: string | null;
  packageName: string;
  currentPrice: number;
  type: string;
  suggestion: string;
  reasoning: string;
}

export async function generatePackageRecommendations(data: PackageRecommendationsData): Promise<{
  overallInsight: string;
  recommendations: PackageRecommendation[];
}> {
  const genAI = await getClient();
  const { studioName, packagesContext, purchaseContext, classContext } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { overallInsight?: string; recommendations?: PackageRecommendation[] };
  try {
    parsed = parseAiResponse<{ overallInsight?: string; recommendations?: PackageRecommendation[] }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.overallInsight || !Array.isArray(parsed.recommendations)) {
    throw new Error("AI response was missing required fields. Please try again.");
  }
  return { overallInsight: String(parsed.overallInsight).trim(), recommendations: parsed.recommendations };
}

interface ReEngagementEmailData {
  studioName: string;
  studentName: string;
  daysSince: number | null;
  neverAttended: boolean;
  unusedCredits: number;
  lastClasses: string[];
  upcomingHighlights: string[];
}

export async function generateReEngagementEmail(data: ReEngagementEmailData): Promise<{ subject: string; body: string }> {
  const genAI = await getClient();
  const { studioName, studentName, daysSince, neverAttended, unusedCredits, lastClasses, upcomingHighlights } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { subject?: string; body?: string };
  try {
    parsed = parseAiResponse<{ subject?: string; body?: string }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.subject || !parsed.body) throw new Error("AI response was missing required fields.");
  return { subject: String(parsed.subject).trim(), body: String(parsed.body).trim() };
}

interface InstructorData {
  name: string;
  classCount: number;
  totalCheckIns: number;
  avgFillRate: number;
  avgRating?: number;
  reviewCount?: number;
}

export async function generateInstructorPerformance(data: {
  studioName: string;
  instructors: InstructorData[];
}): Promise<{ summary: string; instructorInsights: Array<{ name: string; highlights: string[] }> }> {
  const genAI = await getClient();
  const { studioName, instructors } = data;

  const instructorLines = instructors.map((i) => {
    const avgRating = i.avgRating
      ? ` | Avg review: ${i.avgRating}/5 (${i.reviewCount} review${i.reviewCount !== 1 ? "s" : ""})`
      : " | No reviews yet";
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
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { summary?: string; instructorInsights?: Array<{ name: string; highlights: string[] }> };
  try {
    parsed = parseAiResponse<{ summary?: string; instructorInsights?: Array<{ name: string; highlights: string[] }> }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary || !Array.isArray(parsed.instructorInsights)) throw new Error("AI response was missing required fields.");
  return { summary: String(parsed.summary).trim(), instructorInsights: parsed.instructorInsights };
}

interface StudentProgressReportData {
  studioName: string;
  studentName: string;
  totalCheckIns: number;
  checkIns30Days: number;
  uniqueClasses: number;
  classNames: string[];
  memberSince: string;
  credits: number;
}

export async function generateStudentProgressReport(data: StudentProgressReportData): Promise<{ report: string }> {
  const genAI = await getClient();
  const { studioName, studentName, totalCheckIns, checkIns30Days, uniqueClasses, classNames, memberSince, credits } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { report?: string };
  try {
    parsed = parseAiResponse<{ report?: string }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.report) throw new Error("AI response was missing the report field.");
  return { report: String(parsed.report).trim() };
}

interface ClassDemandItem {
  classId: string;
  name: string;
  genre: string;
  level: string;
  dayOfWeek: string;
  startTime: string;
  maxCapacity: number;
  fillRate: number;
  checkIns: number;
}

interface ClassDemandResult {
  classId: string;
  name: string;
  status: string;
  action: string;
  reasoning: string;
}

export async function generateClassDemandAnalysis(data: {
  studioName: string;
  classes: ClassDemandItem[];
}): Promise<{ summary: string; classes: ClassDemandResult[] }> {
  const genAI = await getClient();
  const { studioName, classes } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { summary?: string; classes?: ClassDemandResult[] };
  try {
    parsed = parseAiResponse<{ summary?: string; classes?: ClassDemandResult[] }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format. Please try again.");
  }
  if (!parsed.summary || !Array.isArray(parsed.classes)) throw new Error("AI response was missing required fields.");
  return { summary: String(parsed.summary).trim(), classes: parsed.classes };
}

interface PromoEntity {
  name: string;
  type?: string;
  startTime?: string;
  danceGenre?: string;
  levels?: string | string[];
  level?: string;
  priceTiers?: Array<{ price?: number }>;
  cost?: number;
  locationName?: string;
  description?: string;
}

export async function generatePromoCopy(data: {
  studioName: string;
  entity: PromoEntity;
  entityType: string;
}): Promise<{ instagram: string; facebook: string; emailSubject: string; promoBlurb: string }> {
  const genAI = await getClient();
  const { studioName, entity, entityType } = data;

  const dateStr = entity.startTime ? new Date(entity.startTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "TBD";
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
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { instagram?: string; facebook?: string; emailSubject?: string; promoBlurb?: string };
  try {
    parsed = parseAiResponse<{ instagram?: string; facebook?: string; emailSubject?: string; promoBlurb?: string }>(text);
  } catch {
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

interface MonthlyRevenueEntry {
  month: string;
  revenue: number;
  stripe?: number;
  cash?: number;
}

interface RevenueForecastData {
  studioName: string;
  monthlyRevenue: MonthlyRevenueEntry[];
  activeSubscriptions: number;
  avgMonthlyGrowth: number;
  cashPercent?: number;
}

export async function generateRevenueForecast(data: RevenueForecastData): Promise<{
  forecast: string;
  projectedRevenue: { low: number; mid: number; high: number };
  drivers: string[];
  risks: string[];
}> {
  const genAI = await getClient();
  const { studioName, monthlyRevenue, activeSubscriptions, avgMonthlyGrowth, cashPercent = 0 } = data;

  const revenueLines = monthlyRevenue.map((m) => {
    const cashNote = (m.cash ?? 0) > 0 ? ` (Stripe: $${(m.stripe ?? 0).toFixed(2)}, Cash: $${(m.cash ?? 0).toFixed(2)})` : "";
    return `  ${m.month}: $${m.revenue.toFixed(2)}${cashNote}`;
  }).join("\n");

  const prompt = `You are a financial analyst for "${studioName}", a dance studio.

REVENUE HISTORY (last 6 months, Stripe + cash combined):
${revenueLines || "No historical data available."}

Active recurring subscriptions: ${activeSubscriptions}
Average month-over-month growth: ${avgMonthlyGrowth > 0 ? "+" : ""}${avgMonthlyGrowth}%
Cash payments as % of total revenue: ${cashPercent}%

Based on this data, forecast next month's revenue. Consider both card/online payments and cash payments in your analysis. Provide:
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
    generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { forecast?: string; projectedRevenue?: { low: number; mid: number; high: number }; drivers?: string[]; risks?: string[] };
  try {
    parsed = parseAiResponse<typeof parsed>(text);
  } catch {
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

// ─── Student LTV ──────────────────────────────────────────────────────────────

interface StudentLTVEntry {
  studentId: string;
  name: string;
  totalSpent: number;
  monthsAsCustomer: number;
  avgMonthlySpend: number;
  projected12Month: number;
}

export async function generateStudentLTVInsights(data: {
  studioName: string;
  topStudents: StudentLTVEntry[];
  avgLTV: number;
  totalStudents: number;
}): Promise<{ summary: string; insights: string[] }> {
  const genAI = await getClient();
  const { studioName, topStudents, avgLTV, totalStudents } = data;

  const lines = topStudents.slice(0, 10).map((s) =>
    `  - ${s.name}: $${s.totalSpent.toFixed(2)} total | ${s.monthsAsCustomer}mo tenure | $${s.avgMonthlySpend.toFixed(2)}/mo avg | $${s.projected12Month.toFixed(2)} projected/year`,
  ).join("\n");

  const prompt = `You are a customer success analyst for "${studioName}", a dance studio.

STUDENT LIFETIME VALUE DATA:
Total students analyzed: ${totalStudents}
Average LTV: $${avgLTV.toFixed(2)}

Top students by LTV:
${lines || "No purchase data available."}

Provide:
1. A 2-sentence summary of the studio's LTV health
2. 3-4 bullet insights using 💎 for high-value patterns, ⚠️ for risks, 💡 for opportunities

Return ONLY valid JSON (no markdown):
{"summary": "...", "insights": ["💎 ...", "💡 ..."]}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { summary?: string; insights?: string[] };
  try {
    parsed = parseAiResponse<{ summary?: string; insights?: string[] }>(text);
  } catch {
    throw new Error("AI returned an unexpected response format.");
  }
  if (!parsed.summary || !Array.isArray(parsed.insights)) throw new Error("AI response missing required fields.");
  return { summary: String(parsed.summary).trim(), insights: parsed.insights.map((i) => String(i).trim()) };
}

// ─── Promo Triggers ────────────────────────────────────────────────────────────

interface PromoTriggerClass {
  classId: string;
  name: string;
  genre: string;
  dayOfWeek: string;
  startTime: string;
  maxCapacity: number;
  weeklyFillRates: number[];
  avgFillRate: number;
}

export async function generatePromoTriggerSuggestions(data: {
  studioName: string;
  underperformingClasses: PromoTriggerClass[];
}): Promise<{ triggers: Array<{ classId: string; suggestion: string; urgency: "high" | "medium" | "low" }> }> {
  const genAI = await getClient();
  const { studioName, underperformingClasses } = data;

  const lines = underperformingClasses.map((c) => {
    const weekLabels = c.weeklyFillRates.map((r, i) => `W${i + 1}:${r}%`).join(", ");
    return `  - [${c.classId}] "${c.name}" | ${c.genre} | ${c.dayOfWeek} ${c.startTime} | Fill rates: ${weekLabels} | Avg: ${c.avgFillRate}%`;
  }).join("\n");

  const prompt = `You are a marketing advisor for "${studioName}", a dance studio.

UNDERPERFORMING CLASSES (fill rate < 40% in multiple recent weeks):
${lines || "No underperforming classes."}

For each class, suggest ONE specific promo action (e.g., "Offer a bring-a-friend free trial this week", "Drop price by $5 for the next 3 sessions", "Send a flash promo to students who haven't attended in 2 weeks").
Keep suggestions concise (max 15 words each). Urgency: "high" if avg fill < 20%, "medium" if 20-30%, "low" if 30-40%.

Return ONLY valid JSON (no markdown):
{"triggers": [{"classId": "id", "suggestion": "...", "urgency": "high|medium|low"}]}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { triggers?: Array<{ classId: string; suggestion: string; urgency: "high" | "medium" | "low" }> };
  try {
    parsed = parseAiResponse<typeof parsed>(text);
  } catch {
    throw new Error("AI returned an unexpected response format.");
  }
  if (!Array.isArray(parsed.triggers)) throw new Error("AI response missing triggers.");
  return { triggers: parsed.triggers };
}

// ─── Schedule Health ───────────────────────────────────────────────────────────

interface ScheduleHealthData {
  studioName: string;
  scheduleContext: string;
  coverageGaps: string;
}

export async function generateScheduleHealth(data: ScheduleHealthData): Promise<{
  summary: string;
  strengths: string[];
  gaps: string[];
  recommendations: string[];
}> {
  const genAI = await getClient();
  const { studioName, scheduleContext, coverageGaps } = data;

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
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  let parsed: { summary?: string; strengths?: string[]; gaps?: string[]; recommendations?: string[] };
  try {
    parsed = parseAiResponse<typeof parsed>(text);
  } catch {
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
