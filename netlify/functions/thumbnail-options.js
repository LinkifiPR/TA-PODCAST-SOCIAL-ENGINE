const fs = require("fs/promises");
const { loadEnvFile } = require("./lib/env");

loadEnvFile();

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const ALL_FORMATS = [
  "TITLE HEAD",
  "DRAMATIC FACE",
  "A AFFECTS B",
  "CONVERSATION QUESTION",
  "3-PANEL PROGRESS",
  "PROBLEM STATE",
  "CONTRAST",
  "DON'T DO THIS",
  "ELIMINATORS",
  "MOTION ARROW",
  "CONFLICT",
  "MID PROGRESSION",
  "COMMENT / POST",
  "ACCUSATION",
  "REVIEW",
];

const DEFAULT_HEADSHOT_CHOICES = [
  "confident.png",
  "Disappointed.png",
  "Pointing.png",
  "shocked.png",
  "surprised.png",
];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function normalizeHeadshotName(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return "";
  const canonicalMap = {
    "confident": "confident.png",
    "confident.png": "confident.png",
    "disappointed": "Disappointed.png",
    "disappointed.png": "Disappointed.png",
    "pointing": "Pointing.png",
    "pointing.png": "Pointing.png",
    "shocked": "shocked.png",
    "shocked.png": "shocked.png",
    "surprised": "surprised.png",
    "surprised.png": "surprised.png",
  };
  return canonicalMap[lower] || name;
}

function formatHeadshotFit(formatName) {
  const always = new Set([
    "TITLE HEAD",
    "DRAMATIC FACE",
    "CONVERSATION QUESTION",
    "PROBLEM STATE",
    "DON'T DO THIS",
    "CONFLICT",
    "COMMENT / POST",
    "ACCUSATION",
  ]);
  const sometimes = new Set([
    "A AFFECTS B",
    "CONTRAST",
    "MOTION ARROW",
    "MID PROGRESSION",
    "REVIEW",
  ]);
  if (always.has(formatName)) return "yes";
  if (sometimes.has(formatName)) return "sometimes";
  return "rarely";
}

function clampOverlayText(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

function sanitizeFormatName(name) {
  const upper = String(name || "").trim().toUpperCase();
  if (ALL_FORMATS.includes(upper)) return upper;
  return "ACCUSATION";
}

function fallbackRecommendation(sourceText) {
  const haystack = String(sourceText || "").toLowerCase();

  let recommendedFormat = "ACCUSATION";
  let recommendedReason = "Direct challenge framing creates urgency for this topic.";

  if (/\b(review|rating|worth it|price)\b/.test(haystack)) {
    recommendedFormat = "REVIEW";
    recommendedReason = "The topic fits a verdict-style thumbnail with clear judgement.";
  } else if (/\b(vs|versus|compared|compare|difference)\b/.test(haystack)) {
    recommendedFormat = "CONTRAST";
    recommendedReason = "A side-by-side contrast gives immediate visual clarity.";
  } else if (/\b(mistake|wrong|stop|avoid|kill|invisible)\b/.test(haystack)) {
    recommendedFormat = "DON'T DO THIS";
    recommendedReason = "Mistake framing triggers loss aversion and strong click intent.";
  }

  let recommendedHeadshot = "confident.png";
  if (recommendedFormat === "DRAMATIC FACE") recommendedHeadshot = "shocked.png";
  else if (recommendedFormat === "DON'T DO THIS" || recommendedFormat === "ACCUSATION") {
    recommendedHeadshot = "Pointing.png";
  }

  return {
    recommendedFormat,
    recommendedReason,
    alternativeFormats: ALL_FORMATS.filter((f) => f !== recommendedFormat).slice(0, 2),
    recommendedHeadshot,
    headshotReason: "Recommended expression aligns with the emotional hook of this format.",
    includeHeadshotRecommended: formatHeadshotFit(recommendedFormat) === "yes",
    suggestedOverlayText: "AI VISIBILITY GAP",
  };
}

async function listHeadshots(headshotsDir) {
  if (!headshotsDir) return [];
  try {
    const entries = await fs.readdir(headshotsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // continue
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in recommendation output.");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function callOpenAIForThumbnailRecommendation({ sourceText, requestText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on this environment.");
  }

  const systemPrompt = [
    "You are a YouTube thumbnail art director for Total Authority.",
    "Pick the best format from the provided list and recommend headshot + text overlay.",
    "Respond in strict JSON only.",
    "No markdown.",
  ].join(" ");

  const userPrompt = [
    "Analyze this episode context and produce thumbnail setup recommendations.",
    "Allowed formats:",
    ALL_FORMATS.join(", "),
    "Allowed headshots:",
    DEFAULT_HEADSHOT_CHOICES.join(", "),
    "Return JSON with keys:",
    '{"recommendedFormat":"...","recommendedReason":"...","alternativeFormats":["...","..."],"recommendedHeadshot":"...","headshotReason":"...","includeHeadshotRecommended":true,"suggestedOverlayText":"1-4 words"}',
    "Rules:",
    "- recommendedFormat must be one of allowed formats",
    "- alternativeFormats must contain 2 distinct allowed formats",
    "- suggestedOverlayText max 4 words",
    "- no rhetorical questions",
    "- high click intent",
    "",
    "RUN REQUEST:",
    requestText || "Generate thumbnail recommendations",
    "",
    "EPISODE SOURCE:",
    sourceText,
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_THUMBNAIL_RECOMMENDER_MODEL || "gpt-5.4-mini",
      reasoning: { effort: "low" },
      max_output_tokens: 500,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${JSON.stringify(payload)}`);
  }

  const text =
    (typeof payload.output_text === "string" && payload.output_text) ||
    (Array.isArray(payload.output) &&
      payload.output
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((c) => c?.text)
        .filter(Boolean)
        .join("\n")) ||
    "";

  if (!text.trim()) {
    throw new Error("No recommendation text returned from model.");
  }

  return parseJsonObject(text);
}

function finalizeRecommendation(raw) {
  const recommendedFormat = sanitizeFormatName(raw.recommendedFormat);
  const alternativesRaw = Array.isArray(raw.alternativeFormats)
    ? raw.alternativeFormats.map(sanitizeFormatName)
    : [];
  const alternativeFormats = alternativesRaw
    .filter((value, index, arr) => value !== recommendedFormat && arr.indexOf(value) === index)
    .slice(0, 2);
  while (alternativeFormats.length < 2) {
    const candidate = ALL_FORMATS.find(
      (f) => f !== recommendedFormat && !alternativeFormats.includes(f)
    );
    if (!candidate) break;
    alternativeFormats.push(candidate);
  }

  const recommendedHeadshot = normalizeHeadshotName(raw.recommendedHeadshot);
  const includeHeadshotRecommended = Boolean(raw.includeHeadshotRecommended);

  return {
    recommendedFormat,
    recommendedReason:
      String(raw.recommendedReason || "").trim() ||
      "Recommended format best matches the episode hook and emotional tension.",
    alternativeFormats,
    recommendedHeadshot:
      recommendedHeadshot && DEFAULT_HEADSHOT_CHOICES.includes(recommendedHeadshot)
        ? recommendedHeadshot
        : "confident.png",
    headshotReason:
      String(raw.headshotReason || "").trim() ||
      "Recommended expression aligns with the emotional hook of this format.",
    includeHeadshotRecommended,
    suggestedOverlayText:
      clampOverlayText(raw.suggestedOverlayText) || "AI VISIBILITY GAP",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const sourceText = String(body.transcript || body.topic || "").trim();
    const requestText = String(body.request || "").trim();

    if (!sourceText) {
      return json(400, { ok: false, error: "Provide transcript or topic for thumbnail analysis." });
    }

    const headshotsDir = process.env.HEADSHOTS_DIR || "/Users/chrispanteli/Documents/YT HEADSHOTS";
    const filesystemHeadshots = await listHeadshots(headshotsDir);
    const headshotChoices = DEFAULT_HEADSHOT_CHOICES;

    let recommendation;
    try {
      const raw = await callOpenAIForThumbnailRecommendation({ sourceText, requestText });
      recommendation = finalizeRecommendation(raw);
    } catch (_) {
      recommendation = fallbackRecommendation(sourceText);
    }

    return json(200, {
      ok: true,
      formats: ALL_FORMATS,
      recommendedFormat: recommendation.recommendedFormat,
      recommendedReason: recommendation.recommendedReason,
      alternatives: recommendation.alternativeFormats,
      headshotFit: formatHeadshotFit(recommendation.recommendedFormat),
      recommendedHeadshot: recommendation.recommendedHeadshot,
      headshotReason: recommendation.headshotReason,
      includeHeadshotRecommended: recommendation.includeHeadshotRecommended,
      suggestedOverlayText: recommendation.suggestedOverlayText,
      headshotChoices,
      availableHeadshots: filesystemHeadshots,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Failed to build thumbnail options." });
  }
};
