import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSecret } from "../utils/secret-manager";

let cachedClient: GoogleGenerativeAI | null = null;

async function getClient(): Promise<GoogleGenerativeAI> {
  if (cachedClient) return cachedClient;
  const apiKey = await getSecret("gemini-api-key");
  if (!apiKey?.trim()) throw new Error("Gemini API key not found in Secret Manager.");
  cachedClient = new GoogleGenerativeAI(apiKey.trim());
  return cachedClient;
}

function parseAiResponse<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  return JSON.parse(cleaned) as T;
}

// ─── Color Schemes ─────────────────────────────────────────────────────────────

interface ColorScheme {
  primary: string;
  secondary: string;
  light: string;
}

const GENRE_COLORS: Record<string, ColorScheme> = {
  salsa:       { primary: "#dc2626", secondary: "#ea580c", light: "#fef2f2" },
  latin:       { primary: "#dc2626", secondary: "#ea580c", light: "#fef2f2" },
  bachata:     { primary: "#7c2d12", secondary: "#dc2626", light: "#fff7ed" },
  merengue:    { primary: "#b91c1c", secondary: "#d97706", light: "#fef2f2" },
  "hip-hop":   { primary: "#7c3aed", secondary: "#2563eb", light: "#f5f3ff" },
  "hip hop":   { primary: "#7c3aed", secondary: "#2563eb", light: "#f5f3ff" },
  hiphop:      { primary: "#7c3aed", secondary: "#2563eb", light: "#f5f3ff" },
  ballet:      { primary: "#db2777", secondary: "#9d174d", light: "#fdf2f8" },
  contemporary:{ primary: "#0f766e", secondary: "#0e7490", light: "#f0fdfa" },
  modern:      { primary: "#0f766e", secondary: "#4338ca", light: "#f0fdfa" },
  jazz:        { primary: "#d97706", secondary: "#1e40af", light: "#fffbeb" },
  tap:         { primary: "#1f2937", secondary: "#374151", light: "#f9fafb" },
  ballroom:    { primary: "#1e3a8a", secondary: "#b45309", light: "#eff6ff" },
  swing:       { primary: "#7f1d1d", secondary: "#1e3a5f", light: "#fef2f2" },
  "k-pop":     { primary: "#ec4899", secondary: "#8b5cf6", light: "#fdf2f8" },
  kpop:        { primary: "#ec4899", secondary: "#8b5cf6", light: "#fdf2f8" },
  belly:       { primary: "#b45309", secondary: "#d97706", light: "#fffbeb" },
  flamenco:    { primary: "#7f1d1d", secondary: "#dc2626", light: "#fef2f2" },
  zumba:       { primary: "#16a34a", secondary: "#d97706", light: "#f0fdf4" },
  default:     { primary: "#6366f1", secondary: "#ec4899", light: "#eef2ff" },
};

function getColors(danceGenre?: string | string[]): ColorScheme {
  const genre = Array.isArray(danceGenre) ? danceGenre[0] : danceGenre;
  if (!genre || typeof genre !== "string") return GENRE_COLORS["default"] as ColorScheme;
  const key = genre.toLowerCase().trim();
  return GENRE_COLORS[key] ?? GENRE_COLORS["default"] as ColorScheme;
}

// ─── Shared SVG Utilities ───────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + " " + word).length <= maxCharsPerLine) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

// ─── Color scheme helpers ──────────────────────────────────────────────────────

export interface CustomColorScheme {
  colors: string[];              // 1–3 hex strings
  style: "solid" | "gradient";
}

function darkenHex(hex: string, factor = 0.55): string {
  const h = hex.replace("#", "");
  const c = (o: number) => Math.round(parseInt(h.slice(o, o + 2), 16) * factor).toString(16).padStart(2, "0");
  return `#${c(0)}${c(2)}${c(4)}`;
}

interface ResolvedColors {
  primary: string;
  secondary: string;
  stops: Array<{ offset: string; color: string }>;
  isSolid: boolean;
}

function resolveColors(
  colorScheme: CustomColorScheme | undefined,
  danceGenre: string | undefined,
): ResolvedColors {
  const genre = getColors(danceGenre);

  if (!colorScheme || colorScheme.colors.length === 0) {
    const { primary, secondary } = genre;
    return {
      primary,
      secondary,
      stops: [{ offset: "0%", color: primary }, { offset: "100%", color: secondary }],
      isSolid: false,
    };
  }

  const [c1, c2, c3] = colorScheme.colors;
  const primary = c1!;
  const secondary = c2 ?? primary;

  if (colorScheme.style === "solid") {
    return { primary, secondary, stops: [], isSolid: true };
  }

  const stops: Array<{ offset: string; color: string }> = c3
    ? [{ offset: "0%", color: c1! }, { offset: "50%", color: c2! }, { offset: "100%", color: c3 }]
    : c2
      ? [{ offset: "0%", color: c1! }, { offset: "100%", color: c2 }]
      : [{ offset: "0%", color: c1! }, { offset: "100%", color: darkenHex(c1!) }];

  return { primary, secondary, stops, isSolid: false };
}

function makeGradDef(id: string, rc: ResolvedColors, x2 = "1", y2 = "1"): string {
  if (rc.isSolid) return "";
  const s = rc.stops.map(({ offset, color }) => `<stop offset="${offset}" stop-color="${color}"/>`).join("");
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${s}</linearGradient>`;
}

function gradFill(id: string, rc: ResolvedColors, solidColor: string): string {
  return rc.isSolid ? solidColor : `url(#${id})`;
}

function contrastText(hex: string): string {
  const h = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? "#111827" : "white";
}

// Ensures a color is dark enough to be readable on a white background.
function safeOnWhite(hex: string): string {
  const h = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.85) return darkenHex(hex, 0.3);
  if (lum > 0.65) return darkenHex(hex, 0.55);
  return hex;
}

// ─── Logo Helper ────────────────────────────────────────────────────────────────

export interface LogoPlacement {
  position: "top" | "bottom";
  align: "left" | "center" | "right";
}

function buildLogoSvg(
  logoBase64: string,
  placement: LogoPlacement,
  W: number,
  coloredBg: boolean,
  footerY: number,
): string {
  const isTop = placement.position === "top";
  const logoW = isTop ? 80 : 110;
  const logoH = isTop ? 48 : 62;
  const y = isTop ? 10 : footerY + 24;

  let x: number;
  if (placement.align === "left") x = isTop ? 20 : 60;
  else if (placement.align === "right") x = W - (isTop ? 20 : 60) - logoW;
  else x = Math.round((W - logoW) / 2);

  const bg = isTop || coloredBg
    ? `<rect x="${x - 6}" y="${y - 6}" width="${logoW + 12}" height="${logoH + 12}" rx="10" fill="white" opacity="0.18"/>`
    : "";

  return `${bg}
  <image href="${logoBase64}" x="${x}" y="${y}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`;
}

// ─── AI Copy Generation ─────────────────────────────────────────────────────────

export interface FlyCopyResult {
  headline: string;
  tagline: string;
  promoBlurb: string;
  callToAction: string;
}

interface FlyerCopyContext {
  type: "event" | "class" | "workshop" | "schedule";
  name: string;
  studioName: string;
  danceGenre?: string;
  level?: string;
  dateStr?: string;
  price?: string;
  location?: string;
  description?: string;
}

export async function generateFlyerCopy(ctx: FlyerCopyContext): Promise<FlyCopyResult> {
  const genAI = await getClient();

  const isSchedule = ctx.type === "schedule";

  const prompt = isSchedule
    ? `You are a marketing copywriter for a dance studio called "${ctx.studioName}".

Write promotional text for a WEEKLY SCHEDULE flyer.
Dance genres offered: ${ctx.danceGenre || "Various styles"}

Return ONLY valid JSON (no markdown):
{
  "headline": "6-8 word energetic headline (e.g. 'Dance More This Week')",
  "tagline": "8-12 word subtitle (e.g. 'Find your perfect class and book your spot today')",
  "promoBlurb": "1-2 sentence max 25 words: invite dancers of all levels to join",
  "callToAction": "3-5 words (e.g. 'Book Your Spot', 'Join A Class')"
}`
    : `You are a marketing copywriter for a dance studio called "${ctx.studioName}".

Write promotional text for a ${ctx.type.toUpperCase()} FLYER.

Content details:
- Name: ${ctx.name}
- Type: ${ctx.type}
- Genre: ${ctx.danceGenre || "Dance"}
- Level: ${ctx.level || "All levels"}
- Date/Time: ${ctx.dateStr || "See schedule"}
- Price: ${ctx.price || "Contact us for pricing"}
- Location: ${ctx.location || ctx.studioName}
- Description: ${ctx.description || ""}

Requirements:
- headline: 4-6 word punchy title (can be the name itself or a creative variant, max 40 chars)
- tagline: 8-12 word energetic subtitle, max 55 chars
- promoBlurb: 1-2 sentences, max 28 words, compelling body copy for the flyer
- callToAction: 3-5 words for the button (e.g. "Register Now", "Get Your Ticket", "Join the Class")

Return ONLY valid JSON (no markdown):
{"headline":"...","tagline":"...","promoBlurb":"...","callToAction":"..."}`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed: FlyCopyResult;
  try {
    parsed = parseAiResponse<FlyCopyResult>(text);
  } catch {
    throw new Error("AI returned an unexpected response format for flyer copy.");
  }

  return {
    headline: String(parsed.headline || ctx.name).trim().slice(0, 60),
    tagline: String(parsed.tagline || "").trim().slice(0, 80),
    promoBlurb: String(parsed.promoBlurb || "").trim().slice(0, 200),
    callToAction: String(parsed.callToAction || "Register Now").trim().slice(0, 30),
  };
}

// ─── SVG Builders ──────────────────────────────────────────────────────────────

export interface EventFlyerData {
  studioName: string;
  name: string;
  danceGenre?: string;
  dateStr?: string;
  timeStr?: string;
  location?: string;
  price?: string;
  description?: string;
  colorScheme?: CustomColorScheme;
  logoBase64?: string;
  logoPlacement?: LogoPlacement;
  copy: FlyCopyResult;
}

export interface ClassFlyerData {
  studioName: string;
  name: string;
  danceGenre?: string;
  level?: string;
  dayOfWeek?: string;
  timeStr?: string;
  price?: string;
  instructorName?: string;
  colorScheme?: CustomColorScheme;
  logoBase64?: string;
  logoPlacement?: LogoPlacement;
  copy: FlyCopyResult;
}

export interface ScheduleInstructor {
  name: string;
  photo: string | null;
}

export interface ScheduleClass {
  name: string;
  dayOfWeek: string;
  startTime: string;
  endTime?: string;
  cost?: number;
  danceGenre?: string;
  level?: string;
  instructors?: ScheduleInstructor[];
}

export interface ScheduleFlyerData {
  studioName: string;
  danceGenre?: string;
  weekLabel?: string;
  classes: ScheduleClass[];
  colorScheme?: CustomColorScheme;
  logoBase64?: string;
  logoPlacement?: LogoPlacement;
  copy: FlyCopyResult;
}

// ── Event / Workshop Flyer (1080×1350) ────────────────────────────────────────

export function buildEventOrWorkshopFlyer(data: EventFlyerData): string {
  const W = 1080;
  const H = 1350;
  const rc = resolveColors(data.colorScheme, data.danceGenre);
  const { primary, secondary } = rc;
  const fg = contrastText(rc.primary);   // text color on the colored background
  const CX = W / 2;
  const IMPACT = "Impact,'Arial Black',system-ui,sans-serif";
  const SANS = "system-ui,-apple-system,Arial,sans-serif";

  // Headline — Impact font, ~14 chars/line
  const headlineLines = wrapText(data.copy.headline.toUpperCase(), 14);
  const hSize = headlineLines.length >= 3 ? 76 : headlineLines.length === 2 ? 86 : 96;
  const hLineH = hSize + 14;
  // Date (if present) sits above the headline at a modest size.
  // The headline baseline must be ≥ date-baseline + date-size + 60 to avoid overlap.
  const hStartY = data.dateStr ? Math.max(265, 148 + 26 + 60 + hSize) : 200;
  const hEndY = hStartY + headlineLines.length * hLineH;

  // Genre badge sits just below the headline
  const genreY = hEndY + 20;
  // Promo blurb: max 2 lines (1 if headline is 3 lines)
  const blurbMaxLines = headlineLines.length >= 3 ? 1 : 2;
  const blurbStartY = genreY + (data.danceGenre ? 64 : 18);
  const blurbLines = wrapText(data.copy.promoBlurb, 48).slice(0, blurbMaxLines);

  // Angled cut between colored top and white bottom
  const cutL = 748;  // y on left edge
  const cutR = 674;  // y on right edge (higher = more dramatic angle)

  // White section — absolute Y positions
  const locLines = data.location
    ? wrapText(data.location.toUpperCase(), 18).slice(0, 2)
    : [];
  const locY    = cutR + 70;
  const ruleY   = locY + locLines.length * 62 + 14;

  // Info blocks: Date | Time | Price
  const infoItems: Array<{ label: string; value: string }> = [];
  if (data.dateStr) infoItems.push({ label: "DATE",  value: data.dateStr });
  if (data.timeStr) infoItems.push({ label: "TIME",  value: data.timeStr });
  if (data.price)   infoItems.push({ label: "PRICE", value: data.price });
  const infoY   = ruleY + 28;
  const ctaY    = infoY + (infoItems.length > 0 ? 108 : 20);
  const footerY = ctaY + 112;

  const infoBlockW    = infoItems.length > 0 ? Math.min(800 / infoItems.length, 276) : 0;
  const infoTotalW    = infoItems.length * infoBlockW + (infoItems.length - 1) * 16;
  const infoStartX    = CX - infoTotalW / 2;
  const safeP = safeOnWhite(primary);
  const infoBlocksSvg = infoItems.map((item, i) => {
    const bx    = infoStartX + i * (infoBlockW + 16);
    const bcx   = bx + infoBlockW / 2;
    const vLines = wrapText(item.value, Math.max(8, Math.floor(infoBlockW / 13))).slice(0, 2);
    const boxH  = 76 + (vLines.length - 1) * 26;
    return `
  <rect x="${bx}" y="${infoY}" width="${infoBlockW}" height="${boxH}" rx="14" fill="${safeP}" opacity="0.09"/>
  <text x="${bcx}" y="${infoY + 20}" font-family="${SANS}" font-size="13" font-weight="700" fill="${safeP}" text-anchor="middle" letter-spacing="2" opacity="0.7">${escapeXml(item.label)}</text>
  ${vLines.map((line, vi) => `<text x="${bcx}" y="${infoY + 46 + vi * 26}" font-family="${SANS}" font-size="${vLines.length > 1 ? 18 : 21}" font-weight="700" fill="#111827" text-anchor="middle">${escapeXml(line)}</text>`).join("\n")}`;
  }).join("\n");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${makeGradDef("bgGrad", rc, "1", "1")}
    ${makeGradDef("btnGrad", rc, "1", "0")}
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="${gradFill("bgGrad", rc, primary)}"/>

  <!-- Decorative circles -->
  <circle cx="1042" cy="75"  r="390" fill="white" opacity="0.07"/>
  <circle cx="38"   cy="1282" r="430" fill="white" opacity="0.05"/>
  <circle cx="160"  cy="600"  r="220" fill="white" opacity="0.04"/>

  <!-- Diagonal accent bands -->
  <polygon points="0,442 ${W},362 ${W},392 0,472" fill="white" opacity="0.055"/>
  <polygon points="0,476 ${W},396 ${W},406 0,482" fill="white" opacity="0.030"/>

  <!-- ★  STUDIO NAME  ★ -->
  <text x="${CX}" y="84"
    font-family="${SANS}" font-size="21" font-weight="700"
    fill="${fg}" text-anchor="middle" letter-spacing="4" opacity="0.93">
    ★  ${escapeXml(data.studioName.toUpperCase())}  ★
  </text>
  <line x1="${CX - 260}" y1="108" x2="${CX + 260}" y2="108" stroke="${fg}" stroke-width="1" opacity="0.28"/>

  ${data.dateStr ? `<!-- Date -->
  <text x="${CX}" y="148"
    font-family="${SANS}" font-size="26" font-weight="600"
    fill="${fg}" text-anchor="middle" letter-spacing="5" opacity="0.85">
    ${escapeXml(data.dateStr.toUpperCase())}
  </text>` : ""}

  <!-- HUGE Headline – Impact font -->
  ${headlineLines.map((line, i) => `
  <text x="${CX}" y="${hStartY + i * hLineH}"
    font-family="${IMPACT}" font-size="${hSize}" fill="${fg}" text-anchor="middle" letter-spacing="1">
    ${escapeXml(line)}
  </text>`).join("")}

  ${data.danceGenre ? `<!-- Genre badge -->
  <rect x="${CX - 125}" y="${genreY}" width="250" height="48" rx="24" fill="${fg}" opacity="0.15"/>
  <text x="${CX}" y="${genreY + 32}"
    font-family="${SANS}" font-size="19" font-weight="700"
    fill="${fg}" text-anchor="middle" letter-spacing="4">
    ${escapeXml(data.danceGenre.toUpperCase())}
  </text>` : ""}

  <!-- Promo blurb -->
  ${blurbLines.map((line, i) => `
  <text x="${CX}" y="${blurbStartY + i * 34}"
    font-family="${SANS}" font-size="23" fill="${fg}" text-anchor="middle" opacity="0.82">
    ${escapeXml(line)}
  </text>`).join("")}

  <!-- Angled white section -->
  <polygon points="0,${cutL} ${W},${cutR} ${W},${H} 0,${H}" fill="white"/>

  <!-- Location (big Impact, primary color) -->
  ${locLines.map((line, i) => `
  <text x="${CX}" y="${locY + i * 62}"
    font-family="${IMPACT}" font-size="52" fill="${safeP}" text-anchor="middle">
    ${escapeXml(line)}
  </text>`).join("")}

  <!-- Rule under location -->
  <line x1="120" y1="${ruleY}" x2="${W - 120}" y2="${ruleY}" stroke="${safeP}" stroke-width="2" opacity="0.25"/>

  <!-- Info blocks -->
  ${infoBlocksSvg}

  <!-- CTA Button -->
  <rect x="${CX - 300}" y="${ctaY}" width="600" height="74" rx="37" fill="${gradFill("btnGrad", rc, safeOnWhite(secondary))}"/>
  <text x="${CX}" y="${ctaY + 48}"
    font-family="${SANS}" font-size="26" font-weight="800"
    fill="${contrastText(rc.isSolid ? safeOnWhite(secondary) : safeOnWhite(rc.stops[0]?.color ?? primary))}" text-anchor="middle" letter-spacing="3">
    ${escapeXml(data.copy.callToAction.toUpperCase())}
  </text>

  <!-- Studio footer -->
  <text x="${CX}" y="${footerY}"
    font-family="${SANS}" font-size="18" fill="#9ca3af" text-anchor="middle">
    ${escapeXml(data.studioName)}
  </text>

  ${data.logoBase64 && data.logoPlacement ? buildLogoSvg(data.logoBase64, data.logoPlacement, W, data.logoPlacement.position === "top", footerY) : ""}
</svg>`;
}

// ── Class Flyer (1080×1350) — "MONDAYS" style ─────────────────────────────────

export function buildClassFlyer(data: ClassFlyerData): string {
  const W = 1080;
  const H = 1350;
  const rc = resolveColors(data.colorScheme, data.danceGenre);
  const { primary, secondary } = rc;
  const fg = contrastText(rc.primary);
  const CX = W / 2;
  const IMPACT = "Impact,'Arial Black',system-ui,sans-serif";
  const SANS  = "system-ui,-apple-system,Arial,sans-serif";

  // Pluralise the day name so it reads like "MONDAYS", "TUESDAYS", etc.
  const dayRaw  = (data.dayOfWeek ?? "").trim();
  const dayHero = dayRaw
    ? (dayRaw.toUpperCase().endsWith("S") ? dayRaw.toUpperCase() : dayRaw.toUpperCase() + "S")
    : "";
  const dayFontSize = dayHero.length <= 7 ? 112 : dayHero.length <= 9 ? 96 : 80;

  // Class name below the day hero
  const classNameLines = wrapText(data.name.toUpperCase(), 16).slice(0, 2); // Impact at 58px

  // Vertical stack in the colored section
  const genreY      = 128;                                                 // genre badge
  const everyY      = data.danceGenre ? 222 : 170;                        // "EVERY"
  const dayY        = everyY + 34 + dayFontSize;                          // DAY NAME baseline
  const classNameY  = dayY + 70;                                           // first class name line
  const taglineY    = classNameY + classNameLines.length * 66 + 24;       // tagline

  // Angled cut
  const cutL = 720;
  const cutR = 648;

  // White section
  const timeY       = cutR + 65;
  const levelPriceY = timeY + (data.timeStr ? 82 : 10);
  const ctaY        = levelPriceY + (data.level || data.price ? 98 : 20);
  const blurbY      = ctaY + 90;
  const footerY     = blurbY + 44;

  // Level + Price blocks
  const blocks: Array<{ label: string; value: string }> = [];
  if (data.level) blocks.push({ label: "LEVEL", value: data.level });
  if (data.price) blocks.push({ label: "PRICE", value: data.price });
  const blockW   = 240;
  const blockGap = 24;
  const blockTotalW = blocks.length * blockW + (blocks.length - 1) * blockGap;
  const blockStartX = CX - blockTotalW / 2;
  const safeP = safeOnWhite(primary);
  const blocksSvg = blocks.map((b, i) => {
    const bx  = blockStartX + i * (blockW + blockGap);
    const bcx = bx + blockW / 2;
    return `
  <rect x="${bx}" y="${levelPriceY}" width="${blockW}" height="72" rx="14" fill="${safeP}" opacity="0.09"/>
  <text x="${bcx}" y="${levelPriceY + 20}" font-family="${SANS}" font-size="13" font-weight="700" fill="${safeP}" text-anchor="middle" letter-spacing="2" opacity="0.7">${escapeXml(b.label)}</text>
  <text x="${bcx}" y="${levelPriceY + 52}" font-family="${SANS}" font-size="24" font-weight="700" fill="#111827" text-anchor="middle">${escapeXml(b.value)}</text>`;
  }).join("\n");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${makeGradDef("bgGrad", rc, "1", "1")}
    ${makeGradDef("btnGrad", rc, "1", "0")}
  </defs>

  <rect width="${W}" height="${H}" fill="${gradFill("bgGrad", rc, primary)}"/>

  <!-- Decorative circles -->
  <circle cx="1042" cy="72"   r="380" fill="white" opacity="0.07"/>
  <circle cx="48"   cy="1278" r="420" fill="white" opacity="0.05"/>
  <circle cx="900"  cy="480"  r="260" fill="white" opacity="0.04"/>
  <polygon points="0,398 ${W},318 ${W},348 0,428" fill="white" opacity="0.055"/>

  <!-- ★  STUDIO NAME  ★ -->
  <text x="${CX}" y="80"
    font-family="${SANS}" font-size="21" font-weight="700"
    fill="${fg}" text-anchor="middle" letter-spacing="4" opacity="0.9">
    ★  ${escapeXml(data.studioName.toUpperCase())}  ★
  </text>
  <line x1="${CX - 240}" y1="104" x2="${CX + 240}" y2="104" stroke="${fg}" stroke-width="1" opacity="0.28"/>

  ${data.danceGenre ? `<!-- Genre badge -->
  <rect x="${CX - 115}" y="${genreY}" width="230" height="44" rx="22" fill="${fg}" opacity="0.15"/>
  <text x="${CX}" y="${genreY + 30}"
    font-family="${SANS}" font-size="18" font-weight="700"
    fill="${fg}" text-anchor="middle" letter-spacing="4">
    ${escapeXml(data.danceGenre.toUpperCase())}
  </text>` : ""}

  ${dayHero ? `<!-- "EVERY" -->
  <text x="${CX}" y="${everyY}"
    font-family="${SANS}" font-size="32" font-weight="300"
    fill="${fg}" text-anchor="middle" opacity="0.76" letter-spacing="10">
    EVERY
  </text>

  <!-- DAY HERO (e.g. "MONDAYS") -->
  <text x="${CX}" y="${dayY}"
    font-family="${IMPACT}" font-size="${dayFontSize}"
    fill="${fg}" text-anchor="middle">
    ${escapeXml(dayHero)}
  </text>` : ""}

  <!-- Class name -->
  ${classNameLines.map((line, i) => `
  <text x="${CX}" y="${classNameY + i * 66}"
    font-family="${IMPACT}" font-size="58" fill="${fg}" text-anchor="middle" opacity="0.92">
    ${escapeXml(line)}
  </text>`).join("")}

  <!-- Tagline -->
  <text x="${CX}" y="${taglineY}"
    font-family="${SANS}" font-size="24" fill="${fg}" text-anchor="middle" opacity="0.76">
    ${escapeXml(data.copy.tagline)}
  </text>

  <!-- Angled white section -->
  <polygon points="0,${cutL} ${W},${cutR} ${W},${H} 0,${H}" fill="white"/>

  <!-- Time display -->
  ${data.timeStr ? `
  <text x="${CX}" y="${timeY + 44}"
    font-family="${IMPACT}" font-size="52" fill="${safeP}" text-anchor="middle">
    ${escapeXml(data.timeStr.toUpperCase())}
  </text>` : ""}

  <!-- Level + Price blocks -->
  ${blocksSvg}

  <!-- CTA Button -->
  <rect x="${CX - 300}" y="${ctaY}" width="600" height="74" rx="37" fill="${gradFill("btnGrad", rc, safeOnWhite(secondary))}"/>
  <text x="${CX}" y="${ctaY + 48}"
    font-family="${SANS}" font-size="26" font-weight="800"
    fill="${contrastText(rc.isSolid ? safeOnWhite(secondary) : safeOnWhite(rc.stops[0]?.color ?? primary))}" text-anchor="middle" letter-spacing="3">
    ${escapeXml(data.copy.callToAction.toUpperCase())}
  </text>

  <!-- Blurb line -->
  <text x="${CX}" y="${blurbY}"
    font-family="${SANS}" font-size="19" fill="#6b7280" text-anchor="middle">
    ${escapeXml(wrapText(data.copy.promoBlurb, 54)[0] ?? "")}
  </text>

  <!-- Footer -->
  <text x="${CX}" y="${footerY}"
    font-family="${SANS}" font-size="18" fill="#9ca3af" text-anchor="middle">
    ${escapeXml(data.studioName)}
  </text>

  ${data.logoBase64 && data.logoPlacement ? buildLogoSvg(data.logoBase64, data.logoPlacement, W, data.logoPlacement.position === "top", footerY) : ""}
</svg>`;
}

// ── Weekly Schedule Flyer — dark background, colored day headers ───────────────

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function formatTime(timeStr: string): string {
  if (!timeStr) return "";
  const cleaned = timeStr.trim();
  if (/\d:\d{2}\s?(AM|PM)/i.test(cleaned)) return cleaned;
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hours = parseInt(match[1] as string, 10);
    const mins  = match[2] as string;
    const suffix = hours >= 12 ? "PM" : "AM";
    const h = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    return `${h}:${mins} ${suffix}`;
  }
  return cleaned;
}

export function buildScheduleFlyer(data: ScheduleFlyerData): string {
  const W = 1080;
  const rc = resolveColors(data.colorScheme, data.danceGenre);
  const { primary, secondary } = rc;
  const CX = W / 2;
  const IMPACT = "Impact,'Arial Black',system-ui,sans-serif";
  const SANS  = "system-ui,-apple-system,Arial,sans-serif";
  const DARK_BG  = "#0f172a";   // near-black background
  const DARK_ROW = "#1e293b";   // alternating row tint

  // ── Group and sort classes ──────────────────────────────────────────────────
  const byDay: Record<string, ScheduleClass[]> = {};
  for (const cls of data.classes) {
    const day = cls.dayOfWeek || "Other";
    if (!byDay[day]) byDay[day] = [];
    (byDay[day] as ScheduleClass[]).push(cls);
  }
  for (const day of Object.keys(byDay)) {
    (byDay[day] as ScheduleClass[]).sort((a, b) =>
      (!a.startTime ? 1 : !b.startTime ? -1 : a.startTime.localeCompare(b.startTime)),
    );
  }
  const sortedDays = Object.keys(byDay).sort((a, b) => {
    const ai = DAY_ORDER.indexOf(a);
    const bi = DAY_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // ── Layout constants ────────────────────────────────────────────────────────
  const PAD_X      = 40;
  const CONTENT_W  = W - PAD_X * 2;
  const HEADER_H   = 140;
  const DAY_HDR_H  = 54;
  const ROW_H      = 60;
  const DAY_GAP    = 20;
  const FOOTER_H   = 90;
  const TIME_BOX_W = 132;

  // ── Calculate total SVG height ──────────────────────────────────────────────
  let totalH = HEADER_H + 20;
  for (const day of sortedDays) {
    totalH += DAY_HDR_H + (byDay[day] as ScheduleClass[]).length * ROW_H + DAY_GAP;
  }
  totalH += FOOTER_H + 20;
  totalH = Math.max(1350, totalH);
  if (data.logoBase64 && data.logoPlacement?.position === "bottom") totalH += 88;

  // ── Build day blocks (collect clipPath defs for instructor avatars) ──────────
  const dayHdrTextFill = contrastText(primary);
  const timeTextFill   = contrastText(primary) === "white" ? "white" : primary;
  const AVATAR_R       = 20;   // radius per circle
  const AVATAR_STEP    = 28;   // center-to-center step for overlapping stack
  const AVATAR_RIGHT   = W - PAD_X - 8 - AVATAR_R; // rightmost avatar center X

  let curY = HEADER_H + 20;
  let rowCounter = 0;
  const clipPathDefs: string[] = [];

  const dayBlocksSvg = sortedDays.map((day) => {
    const classes  = byDay[day] as ScheduleClass[];
    const blockY   = curY;

    const dayHdrSvg = `
  <rect x="${PAD_X}" y="${blockY}" width="${CONTENT_W}" height="${DAY_HDR_H}" rx="10" fill="${primary}"/>
  <text x="${PAD_X + 28}" y="${blockY + 36}"
    font-family="${SANS}" font-size="22" font-weight="800" fill="${dayHdrTextFill}" letter-spacing="4">
    ${escapeXml(day.toUpperCase())}
  </text>`;

    const rowsSvg = classes.map((cls, i) => {
      const rowY      = blockY + DAY_HDR_H + i * ROW_H;
      const isAlt     = i % 2 === 1;
      const timeLabel = cls.startTime ? formatTime(cls.startTime) : "";
      const endLabel  = cls.endTime   ? ` – ${formatTime(cls.endTime)}` : "";
      const levelStr  = cls.level ?? "";
      const instrList = (cls.instructors ?? []).slice(0, 3); // max 3 avatars
      const N         = instrList.length;
      // Shrink name allowance slightly when multiple avatars eat into horizontal space
      const maxName   = N >= 3 ? 24 : N === 2 ? 26 : 28;
      const nameUpper = cls.name.toUpperCase();
      const nameTrim  = nameUpper.length > maxName ? nameUpper.slice(0, maxName - 1) + "…" : nameUpper;
      const avatarCY  = rowY + Math.round(ROW_H / 2);
      const baseIdx   = rowCounter;
      rowCounter++;

      // Build overlapping avatar stack (render left→right so rightmost appears on top)
      const avatarSvg = instrList.map((instr, idx) => {
        const cx    = AVATAR_RIGHT - (N - 1 - idx) * AVATAR_STEP;
        const clipId = `ic${baseIdx}-${idx}`;
        // Dark background circle creates a gap/border between overlapping circles
        const bgCircle = `<circle cx="${cx}" cy="${avatarCY}" r="${AVATAR_R + 2}" fill="${DARK_BG}"/>`;
        if (instr.photo) {
          clipPathDefs.push(`<clipPath id="${clipId}"><circle cx="${cx}" cy="${avatarCY}" r="${AVATAR_R}"/></clipPath>`);
          return `${bgCircle}
  <image href="${instr.photo}" x="${cx - AVATAR_R}" y="${avatarCY - AVATAR_R}" width="${AVATAR_R * 2}" height="${AVATAR_R * 2}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>
  <circle cx="${cx}" cy="${avatarCY}" r="${AVATAR_R}" fill="none" stroke="${primary}" stroke-width="1.5" opacity="0.6"/>`;
        }
        const initials = instr.name.split(" ").map((n) => n[0] ?? "").join("").slice(0, 2).toUpperCase();
        return `${bgCircle}
  <circle cx="${cx}" cy="${avatarCY}" r="${AVATAR_R}" fill="${primary}" opacity="0.3"/>
  <text x="${cx}" y="${avatarCY + 6}" font-family="${SANS}" font-size="13" font-weight="700" fill="white" text-anchor="middle">${escapeXml(initials)}</text>`;
      }).join("\n  ");

      return `
  ${isAlt ? `<rect x="${PAD_X}" y="${rowY}" width="${CONTENT_W}" height="${ROW_H}" fill="${DARK_ROW}"/>` : ""}

  <!-- Time box -->
  <rect x="${PAD_X + 8}" y="${rowY + 8}" width="${TIME_BOX_W}" height="${ROW_H - 16}" rx="8" fill="${primary}" opacity="0.22"/>
  <text x="${PAD_X + 8 + TIME_BOX_W / 2}" y="${rowY + 37}"
    font-family="${SANS}" font-size="18" font-weight="700" fill="${timeTextFill}" text-anchor="middle">
    ${escapeXml(timeLabel)}
  </text>

  <!-- Class name -->
  <text x="${PAD_X + TIME_BOX_W + 22}" y="${rowY + 32}"
    font-family="${SANS}" font-size="21" font-weight="700" fill="white">
    ${escapeXml(nameTrim)}
  </text>
  ${levelStr ? `<text x="${PAD_X + TIME_BOX_W + 22}" y="${rowY + 51}"
    font-family="${SANS}" font-size="14" fill="#94a3b8">
    ${escapeXml(levelStr)}${endLabel ? "  " + escapeXml(endLabel.trim()) : ""}
  </text>` : ""}

  <!-- Instructor avatars (stacked right-to-left, up to 3) -->
  ${avatarSvg}

  <!-- Row separator -->
  <line x1="${PAD_X}" y1="${rowY + ROW_H}" x2="${W - PAD_X}" y2="${rowY + ROW_H}" stroke="white" stroke-width="0.5" opacity="0.07"/>`;
    }).join("\n");

    curY += DAY_HDR_H + classes.length * ROW_H + DAY_GAP;
    return dayHdrSvg + rowsSvg;
  });

  // ── Footer ──────────────────────────────────────────────────────────────────
  const footerLineY = curY + 8;
  const footerText  = data.weekLabel
    ? `${data.weekLabel.toUpperCase()}  ·  ${data.studioName.toUpperCase()}`
    : data.studioName.toUpperCase();

  return `<svg width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${makeGradDef("headerGrad", rc, "1", "0")}
    ${clipPathDefs.join("\n    ")}
  </defs>

  <!-- Dark background -->
  <rect width="${W}" height="${totalH}" fill="${DARK_BG}"/>

  <!-- Subtle background texture circles -->
  <circle cx="${W * 0.85}" cy="${totalH * 0.55}" r="500" fill="${primary}" opacity="0.04"/>
  <circle cx="${W * 0.15}" cy="${totalH * 0.7}"  r="400" fill="${secondary}" opacity="0.04"/>

  <!-- Header bar -->
  <rect width="${W}" height="${HEADER_H}" fill="${gradFill("headerGrad", rc, primary)}"/>

  <!-- Studio name in header -->
  <text x="${PAD_X + 10}" y="50"
    font-family="${SANS}" font-size="24" font-weight="700" fill="white" letter-spacing="2">
    ${escapeXml(data.studioName.toUpperCase())}
  </text>

  <!-- "CLASS SCHEDULE" -->
  <text x="${PAD_X + 10}" y="118"
    font-family="${IMPACT}" font-size="58" fill="white">
    CLASS SCHEDULE
  </text>

  ${data.weekLabel ? `<!-- Week label -->
  <text x="${W - PAD_X - 10}" y="100"
    font-family="${SANS}" font-size="20" font-weight="600"
    fill="white" text-anchor="end" opacity="0.82">
    ${escapeXml(data.weekLabel)}
  </text>` : ""}

  <!-- Day blocks -->
  ${dayBlocksSvg.join("\n")}

  <!-- Footer line -->
  <line x1="${PAD_X}" y1="${footerLineY}" x2="${W - PAD_X}" y2="${footerLineY}" stroke="${primary}" stroke-width="2" opacity="0.5"/>

  <!-- Footer text -->
  <text x="${CX}" y="${footerLineY + 34}"
    font-family="${SANS}" font-size="18" font-weight="600" fill="${primary}" text-anchor="middle">
    ${escapeXml(footerText)}
  </text>

  <!-- Sub-footer CTA -->
  <text x="${CX}" y="${footerLineY + 62}"
    font-family="${SANS}" font-size="16" fill="#475569" text-anchor="middle">
    ${escapeXml(data.copy.callToAction)}  ·  ${escapeXml(data.copy.tagline)}
  </text>

  ${data.logoBase64 && data.logoPlacement ? buildLogoSvg(data.logoBase64, data.logoPlacement, W, data.logoPlacement.position === "top", footerLineY + 62) : ""}
</svg>`;
}

