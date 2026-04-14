const fs = require("fs/promises");
const { loadEnvFile } = require("./lib/env");

loadEnvFile();

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

function chooseThumbnailFormat(sourceText, requestText) {
  const haystack = `${sourceText}\n${requestText}`.toLowerCase();
  if (/\b(review|rating|worth it|price)\b/.test(haystack)) {
    return ["REVIEW", "The content is naturally framed as a verdict and value judgement."];
  }
  if (/\b(vs|versus|compared|compare|difference)\b/.test(haystack)) {
    return ["CONTRAST", "The strongest hook is a side-by-side visibility gap."];
  }
  if (/\b(mistake|wrong|stop|avoid|kill|invisible)\b/.test(haystack)) {
    return ["DON'T DO THIS", "The message is about costly mistakes and exclusion risk."];
  }
  if (/\b(shock|surpris|sudden|hidden|nobody knows)\b/.test(haystack)) {
    return ["DRAMATIC FACE", "The core hook is a reveal that should feel immediate and emotional."];
  }
  return ["ACCUSATION", "A direct wake-up call format best matches the urgency in the content."];
}

function chooseHeadshotByFormat(formatName, available) {
  const lower = formatName.toLowerCase();
  let preferred;

  if (lower.includes("dramatic")) preferred = ["shocked.png", "surprised.png"];
  else if (lower.includes("don't do this") || lower.includes("accusation")) preferred = ["pointing.png", "disappointed.png"];
  else if (lower.includes("problem")) preferred = ["disappointed.png", "shocked.png"];
  else if (lower.includes("conversation")) preferred = ["confident.png"];
  else if (lower.includes("motion") || lower.includes("affects")) preferred = ["pointing.png", "surprised.png"];
  else if (lower.includes("conflict")) preferred = ["confident.png", "pointing.png"];
  else if (lower.includes("review")) preferred = ["surprised.png", "shocked.png"];
  else if (lower.includes("title head")) preferred = ["confident.png", "pointing.png"];
  else preferred = ["confident.png", "pointing.png", "surprised.png", "shocked.png"];

  const map = new Map(available.map((name) => [name.toLowerCase(), name]));
  for (const name of preferred) {
    if (map.has(name)) return map.get(name);
  }
  return available[0] || null;
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const sourceText = String(body.transcript || body.topic || "").trim();
    const requestText = String(body.request || "").trim();

    const [recommendedFormat, recommendedReason] = chooseThumbnailFormat(
      sourceText,
      requestText
    );
    const alternatives = ALL_FORMATS.filter((f) => f !== recommendedFormat).slice(0, 2);

    const headshotsDir = process.env.HEADSHOTS_DIR || "/Users/chrispanteli/Documents/YT HEADSHOTS";
    const availableHeadshots = await listHeadshots(headshotsDir);
    const recommendedHeadshot = chooseHeadshotByFormat(
      recommendedFormat,
      availableHeadshots
    );

    return json(200, {
      ok: true,
      formats: ALL_FORMATS,
      recommendedFormat,
      recommendedReason,
      alternatives,
      headshotFit: formatHeadshotFit(recommendedFormat),
      availableHeadshots,
      recommendedHeadshot,
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Failed to build thumbnail options." });
  }
};
