const fs = require("fs/promises");
const path = require("path");
const {
  loadManifest,
  loadPrompt,
  filterAgents,
} = require("./lib/agents");
const { loadEnvFile } = require("./lib/env");

loadEnvFile();

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const NANO_BANANA_PRO_MODEL = "google/gemini-3-pro-image-preview";

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

function buildUserPrompt(sourceText, videoUrl, request) {
  return [
    "Use the input below as the source of truth.",
    "Ground every claim in it. Do not invent stats or findings.",
    "",
    `VIDEO_URL: ${videoUrl || "[VIDEO_URL]"}`,
    "If the output template includes [VIDEO_URL], replace it with VIDEO_URL.",
    "",
    "RUN REQUEST:",
    request || "Generate all sections unless explicitly told otherwise.",
    "",
    "SOURCE INPUT:",
    sourceText,
  ].join("\n");
}

function extractResponsesText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) {
      continue;
    }
    for (const contentItem of item.content) {
      if (
        (contentItem?.type === "output_text" || contentItem?.type === "text") &&
        typeof contentItem?.text === "string" &&
        contentItem.text
      ) {
        chunks.push(contentItem.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

async function callOpenAI({ model, systemPrompt, userPrompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on this environment.");
  }

  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "low";
  const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 2600);

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : 2600,
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

  const text = extractResponsesText(payload);
  if (!text) {
    throw new Error("OpenAI returned no text output.");
  }
  return text;
}

function toDataUrlFromBuffer(buffer, mimeType = "image/png") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function pickHeadshotForFormat(formatName, available) {
  const lower = String(formatName || "").toLowerCase();
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
  for (const wanted of preferred) {
    if (map.has(wanted)) return map.get(wanted);
  }
  return available[0] || null;
}

function chooseThumbnailFormat(sourceText, requestText) {
  const haystack = `${sourceText}\n${requestText}`.toLowerCase();
  if (/\b(review|rating|worth it|price)\b/.test(haystack)) {
    return ["REVIEW", "The content leans on value judgement and recommendation signals."];
  }
  if (/\b(vs|versus|compared|compare|difference)\b/.test(haystack)) {
    return ["CONTRAST", "The topic frames a clear side-by-side visibility gap."];
  }
  if (/\b(mistake|wrong|stop|avoid|kill|invisible)\b/.test(haystack)) {
    return ["DON'T DO THIS", "The transcript highlights costly mistakes and exclusion risk."];
  }
  if (/\b(shock|surpris|sudden|hidden|nobody knows)\b/.test(haystack)) {
    return ["DRAMATIC FACE", "The strongest angle is a reveal that should feel immediate and emotional."];
  }
  return ["ACCUSATION", "The message is a direct wake-up call about AI visibility risk."];
}

function inferTopicPhrase(sourceText) {
  const cleaned = String(sourceText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "AI visibility in search";
  return cleaned.slice(0, 120);
}

function buildThumbnailPlan({ sourceText, request, hasUploadedHeadshot, availableHeadshots }) {
  const [formatName, formatReason] = chooseThumbnailFormat(sourceText, request);
  const includeHeadshot = hasUploadedHeadshot || formatName !== "CONTRAST";
  const recommendedHeadshot = includeHeadshot
    ? pickHeadshotForFormat(formatName, availableHeadshots)
    : null;

  const overlayByFormat = {
    "DON'T DO THIS": "AI IGNORES YOU",
    "DRAMATIC FACE": "INVISIBLE TO AI",
    REVIEW: "WORTH IT?",
    CONTRAST: "GOOGLE VS AI",
    ACCUSATION: "YOU'RE MISSING OUT",
  };
  const textOverlay = overlayByFormat[formatName] || "AI VISIBILITY GAP";

  const topicPhrase = inferTopicPhrase(sourceText);
  const subjectLine = includeHeadshot
    ? "hyper-stylised portrait of the host with a confident, high-contrast expression"
    : "single striking visual metaphor for AI visibility and search exclusion";

  const imagePrompt = [
    `${formatName} style YouTube thumbnail composition`,
    subjectLine,
    `topic emphasis: ${topicPhrase}`,
    "dark charcoal to deep navy gradient background",
    "cinematic directional lighting with sharp subject separation",
    "vivid orange (#F97315) rim light and glow accents as dominant visual signature",
    `bold high-contrast text overlay "${textOverlay}"`,
    "1280x720 YouTube thumbnail, ultra sharp, high contrast, cinematic, minimal composition, no borders, professional art direction",
  ].join(", ");

  return {
    formatName,
    formatReason,
    includeHeadshot,
    recommendedHeadshot,
    headshotReason: includeHeadshot
      ? "Human expression amplifies urgency and click intent for this format."
      : "This format performs better with a clean concept-led visual.",
    textOverlay,
    imagePrompt,
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

function extractOpenRouterImageRef(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const message = choice?.message || {};

    if (Array.isArray(message.images)) {
      for (const img of message.images) {
        if (img?.image_url?.url) return img.image_url.url;
        if (img?.imageUrl?.url) return img.imageUrl.url;
        if (typeof img?.url === "string") return img.url;
      }
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.image_url?.url) return part.image_url.url;
        if (typeof part?.image_url === "string") return part.image_url;
        if ((part?.type === "image_url" || part?.type === "output_image") && typeof part?.url === "string") {
          return part.url;
        }
      }
    }
  }

  const data = Array.isArray(payload?.data) ? payload.data : [];
  for (const item of data) {
    if (typeof item?.url === "string") return item.url;
    if (typeof item?.b64_json === "string") return `data:image/png;base64,${item.b64_json}`;
  }

  throw new Error("No image found in OpenRouter response.");
}

async function callOpenRouterImage({ prompt, imageDataUrl }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured on this environment.");
  }

  const content = [{ type: "text", text: prompt }];
  if (imageDataUrl) {
    content.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }

  const payload = {
    model: NANO_BANANA_PRO_MODEL,
    messages: [{ role: "user", content }],
    modalities: ["image", "text"],
    stream: false,
  };

  const doRequest = async () => {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("401 Invalid API key. Check https://openrouter.ai/keys");
      }
      if (response.status === 402) {
        throw new Error("402 Insufficient credits. Check https://openrouter.ai/credits");
      }
      if (response.status === 429) {
        throw new Error("429 Rate limited");
      }
      throw new Error(`OpenRouter ${response.status}: ${JSON.stringify(body)}`);
    }

    return body;
  };

  let responsePayload;
  try {
    responsePayload = await doRequest();
  } catch (err) {
    if (!String(err.message || "").startsWith("429")) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    responsePayload = await doRequest();
  }

  const imageRef = extractOpenRouterImageRef(responsePayload);
  if (imageRef.startsWith("data:image")) {
    return imageRef;
  }

  const imageResponse = await fetch(imageRef);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch generated image: ${imageResponse.status}`);
  }
  const arrayBuffer = await imageResponse.arrayBuffer();
  const mimeType = imageResponse.headers.get("content-type") || "image/png";
  return toDataUrlFromBuffer(Buffer.from(arrayBuffer), mimeType);
}

async function runTextAgent({ agent, sourceText, videoUrl, request }) {
  const systemPrompt = await loadPrompt(agent.promptPath);
  const userPrompt = buildUserPrompt(sourceText, videoUrl, request);
  const outputText = await callOpenAI({
    model: agent.model,
    systemPrompt,
    userPrompt,
  });

  return {
    agentId: agent.id,
    name: agent.name,
    executor: agent.executor,
    ok: true,
    outputText,
    artifacts: [],
  };
}

async function runThumbnailAgent({
  agent,
  sourceText,
  videoUrl,
  request,
  headshotDataUrl,
  headshotFilename,
}) {
  const headshotsDir = process.env.HEADSHOTS_DIR || "/Users/chrispanteli/Documents/YT HEADSHOTS";
  const availableHeadshots = await listHeadshots(headshotsDir);

  const plan = buildThumbnailPlan({
    sourceText,
    request,
    hasUploadedHeadshot: Boolean(headshotDataUrl),
    availableHeadshots,
  });

  const formatName = plan.formatName;
  const formatReason = plan.formatReason;
  const headshotReason = plan.headshotReason;
  const textOverlay = plan.textOverlay;
  const imagePrompt = plan.imagePrompt;

  let selectedHeadshot = null;
  let selectedHeadshotDataUrl = null;

  if (headshotDataUrl) {
    selectedHeadshot = headshotFilename || "uploaded-headshot";
    selectedHeadshotDataUrl = headshotDataUrl;
  } else {
    const includeHeadshot = plan.includeHeadshot === true;
    if (includeHeadshot && availableHeadshots.length) {
      const recommended = String(plan.recommendedHeadshot || "").trim();
      const chosen =
        (recommended && availableHeadshots.includes(recommended) && recommended) ||
        pickHeadshotForFormat(formatName, availableHeadshots);

      if (chosen) {
        const bytes = await fs.readFile(path.join(headshotsDir, chosen));
        const ext = path.extname(chosen).toLowerCase();
        const mimeType =
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".webp"
              ? "image/webp"
              : "image/png";
        selectedHeadshot = chosen;
        selectedHeadshotDataUrl = toDataUrlFromBuffer(bytes, mimeType);
      }
    }
  }

  const imageDataUrl = await callOpenRouterImage({
    prompt: imagePrompt,
    imageDataUrl: selectedHeadshotDataUrl,
  });

  const outputText = [
    "# Thumbnail Output",
    "",
    `- Format: ${formatName}`,
    `- Format Rationale: ${formatReason}`,
    `- Headshot Used: ${selectedHeadshot || "No"}`,
    `- Headshot Rationale: ${headshotReason || "N/A"}`,
    `- Text Overlay: ${textOverlay || "No text overlay"}`,
    "",
    "## Final Prompt",
    "",
    "```text",
    imagePrompt,
    "```",
  ].join("\n");

  return {
    agentId: agent.id,
    name: agent.name,
    executor: agent.executor,
    ok: true,
    outputText,
    artifacts: [
      {
        type: "image",
        filename: `${agent.id}.png`,
        dataUrl: imageDataUrl,
      },
    ],
  };
}

async function runSingleAgent(args) {
  const { agent } = args;

  try {
    if (agent.executor === "thumbnail") {
      return await runThumbnailAgent(args);
    }
    return await runTextAgent(args);
  } catch (err) {
    return {
      agentId: agent.id,
      name: agent.name,
      executor: agent.executor,
      ok: false,
      error: err.message || String(err),
      outputText: "",
      artifacts: [],
    };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const transcript = String(body.transcript || "").trim();
    const topic = String(body.topic || "").trim();
    const sourceText = transcript || topic;
    if (!sourceText) {
      return json(400, {
        ok: false,
        error: "Provide transcript text or topic.",
      });
    }

    const videoUrl = String(body.videoUrl || "[VIDEO_URL]").trim() || "[VIDEO_URL]";
    const request = String(body.request || "Generate all sections unless explicitly told otherwise.");
    const selectedAgentIds = Array.isArray(body.selectedAgents) ? body.selectedAgents : [];

    const headshotDataUrl = typeof body.headshotDataUrl === "string" ? body.headshotDataUrl : null;
    const headshotFilename = typeof body.headshotFilename === "string" ? body.headshotFilename : null;

    const { agents } = await loadManifest();
    const selectedAgents = filterAgents(agents, selectedAgentIds);
    if (!selectedAgents.length) {
      return json(400, { ok: false, error: "No enabled agents selected." });
    }

    const results = await Promise.all(
      selectedAgents.map((agent) =>
        runSingleAgent({
          agent,
          sourceText,
          videoUrl,
          request,
          headshotDataUrl,
          headshotFilename,
        })
      )
    );

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const failed = results.filter((result) => !result.ok).length;

    return json(200, {
      ok: true,
      runId,
      generatedAt: new Date().toISOString(),
      totalAgents: results.length,
      failedAgents: failed,
      results,
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err.message || "Unexpected error while running agents.",
    });
  }
};
