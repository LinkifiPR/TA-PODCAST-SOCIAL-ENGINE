const fs = require("fs/promises");
const path = require("path");
const {
  findHeadshotByName,
  listAvailableHeadshots,
  pickHeadshotForFormat,
} = require("./headshots");

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const NANO_BANANA_PRO_MODEL = "google/gemini-3-pro-image-preview";

function toDataUrlFromBuffer(buffer, mimeType = "image/png") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
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

function describeFormatReason(formatName) {
  const reasons = {
    "TITLE HEAD": "Strong for expert-led educational hooks with a clear promise.",
    "DRAMATIC FACE": "Best for emotional shock and immediate scroll interruption.",
    "A AFFECTS B": "Useful when one change causes a clear visibility consequence.",
    "CONVERSATION QUESTION": "Great for provocative interview-style framing.",
    "3-PANEL PROGRESS": "Works for before-during-after transformation narratives.",
    "PROBLEM STATE": "Highlights visible failure and raises urgency instantly.",
    CONTRAST: "Creates curiosity through a clear side-by-side difference.",
    "DON'T DO THIS": "Leverages loss aversion and mistake prevention.",
    ELIMINATORS: "Effective when filtering to critical factors only.",
    "MOTION ARROW": "Adds momentum and direction to growth/change stories.",
    CONFLICT: "Builds tension by positioning opposing ideas head-to-head.",
    "MID PROGRESSION": "Shows in-progress momentum and anticipation.",
    "COMMENT / POST": "Anchors curiosity in a specific social proof artifact.",
    ACCUSATION: "Directly challenges the viewer and creates personal stakes.",
    REVIEW: "Works for verdict-style value judgement and comparison.",
  };
  return reasons[formatName] || "Matched to the transcript hook and emotional tension.";
}

function normalizeAdditionalInstructions(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function buildThumbnailPlan({ sourceText, request, hasUploadedHeadshot, availableHeadshots }) {
  const [recommendedFormatName] = chooseThumbnailFormat(sourceText, request);
  const fit = formatHeadshotFit(recommendedFormatName);
  const includeHeadshot = hasUploadedHeadshot || fit === "yes";
  const recommendedHeadshot = includeHeadshot
    ? pickHeadshotForFormat(recommendedFormatName, availableHeadshots)
    : null;

  const overlayByFormat = {
    "DON'T DO THIS": "",
    "DRAMATIC FACE": "",
    REVIEW: "WORTH IT?",
    CONTRAST: "GOOGLE VS AI",
    ACCUSATION: "",
  };
  const textOverlay = overlayByFormat[recommendedFormatName] || "";

  return {
    recommendedFormatName,
    includeHeadshot,
    recommendedHeadshot: recommendedHeadshot ? recommendedHeadshot.actualFilename : "",
    recommendedTextOverlay: textOverlay,
  };
}

function extractOpenRouterImageRef(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const message = choice?.message || {};

    if (message?.image_url?.url) return message.image_url.url;
    if (typeof message?.image_url === "string") return message.image_url;
    if (typeof message?.url === "string") return message.url;

    if (Array.isArray(message.images)) {
      for (const img of message.images) {
        if (img?.image_url?.url) return img.image_url.url;
        if (img?.imageUrl?.url) return img.imageUrl.url;
        if (typeof img?.image_url === "string") return img.image_url;
        if (typeof img?.b64_json === "string") return `data:image/png;base64,${img.b64_json}`;
        if (typeof img?.url === "string") return img.url;
      }
    }

    if (typeof message.content === "string" && message.content) {
      const dataUrlMatch = message.content.match(
        /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/
      );
      if (dataUrlMatch?.[0]) return dataUrlMatch[0];

      const urlMatch = message.content.match(/https?:\/\/\S+/);
      if (urlMatch?.[0]) return urlMatch[0];
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.image_url?.url) return part.image_url.url;
        if (typeof part?.image_url === "string") return part.image_url;
        if (typeof part?.b64_json === "string") return `data:image/png;base64,${part.b64_json}`;
        if (typeof part?.url === "string" && /^https?:\/\//.test(part.url)) return part.url;
        if (
          (part?.type === "image_url" || part?.type === "output_image") &&
          typeof part?.url === "string"
        ) {
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

  const requestedTokenCap = Number(process.env.OPENROUTER_IMAGE_MAX_TOKENS || 384);
  const primaryMaxTokens = Number.isFinite(requestedTokenCap)
    ? Math.max(128, Math.trunc(requestedTokenCap))
    : 384;
  const fallbackMaxTokens = Math.max(primaryMaxTokens, 768);

  const doRequest = async (maxTokens) => {
    const payload = {
      model: NANO_BANANA_PRO_MODEL,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      max_tokens: maxTokens,
      stream: false,
    };

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

  const runWith429Retry = async (maxTokens) => {
    try {
      return await doRequest(maxTokens);
    } catch (err) {
      if (!String(err.message || "").startsWith("429")) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return doRequest(maxTokens);
    }
  };

  let responsePayload;
  responsePayload = await runWith429Retry(primaryMaxTokens);

  let imageRef;
  try {
    imageRef = extractOpenRouterImageRef(responsePayload);
  } catch (firstErr) {
    if (fallbackMaxTokens === primaryMaxTokens) {
      throw firstErr;
    }
    responsePayload = await runWith429Retry(fallbackMaxTokens);
    imageRef = extractOpenRouterImageRef(responsePayload);
  }
  if (imageRef.startsWith("data:image")) {
    return {
      dataUrl: imageRef,
      url: null,
    };
  }

  return {
    dataUrl: null,
    url: imageRef,
  };
}

async function generateThumbnailResult({
  agentId = "yt-thumbnail-generator",
  agentName = "YouTube Thumbnail Generator",
  sourceText,
  request,
  headshotDataUrl,
  headshotFilename,
  thumbnailConfig,
}) {
  const { headshots: availableHeadshots } = await listAvailableHeadshots(
    process.env.HEADSHOTS_DIR
  );

  const plan = buildThumbnailPlan({
    sourceText,
    request,
    hasUploadedHeadshot: Boolean(headshotDataUrl),
    availableHeadshots,
  });

  const chosenFormat = String(
    thumbnailConfig?.formatName || plan.recommendedFormatName || "ACCUSATION"
  ).toUpperCase();
  const includeHeadshot =
    typeof thumbnailConfig?.includeHeadshot === "boolean"
      ? thumbnailConfig.includeHeadshot
      : plan.includeHeadshot === true;
  const chosenHeadshot = String(
    thumbnailConfig?.autoHeadshot || plan.recommendedHeadshot || ""
  ).trim();
  const chosenOverlayRaw =
    typeof thumbnailConfig?.textOverlay === "string"
      ? thumbnailConfig.textOverlay.trim()
      : plan.recommendedTextOverlay || "";
  const chosenOverlay = chosenOverlayRaw
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  const chosenAdditionalInstructions = normalizeAdditionalInstructions(
    thumbnailConfig?.additionalInstructions
  );

  const formatReason = describeFormatReason(chosenFormat);

  let selectedHeadshot = null;
  let selectedHeadshotDataUrl = null;
  let selectedHeadshotMeta = null;
  let headshotReason = "This format performs better with a clean concept-led visual.";

  if (includeHeadshot && headshotDataUrl) {
    selectedHeadshot = headshotFilename || "uploaded-headshot";
    selectedHeadshotDataUrl = headshotDataUrl;
    headshotReason = "Uploaded headshot override supplied by the user for this run.";
  } else if (includeHeadshot) {
    if (!availableHeadshots.length) {
      throw new Error(
        "Headshot was requested but no saved headshot library is available. Upload a headshot file in the UI and rerun."
      );
    }

    const chosenMeta =
      findHeadshotByName(chosenHeadshot, availableHeadshots) ||
      pickHeadshotForFormat(chosenFormat, availableHeadshots);

    if (!chosenMeta) {
      throw new Error("Headshot was requested, but no matching headshot file was found on server.");
    }

    const bytes = await fs.readFile(chosenMeta.fullPath);
    const ext = path.extname(chosenMeta.actualFilename).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : "image/png";
    selectedHeadshot = chosenMeta.actualFilename;
    selectedHeadshotMeta = chosenMeta;
    selectedHeadshotDataUrl = toDataUrlFromBuffer(bytes, mimeType);
    headshotReason = chosenMeta.description;
  }

  const promptSegments = [
    `${chosenFormat} style YouTube thumbnail composition`,
    selectedHeadshotDataUrl
      ? "hyper-stylised portrait of the host as the dominant focal subject"
      : "single striking visual metaphor for AI visibility and search exclusion",
    "focus on AI visibility, recommendation engines, and brand discoverability",
    "dark charcoal to deep navy gradient background",
    "cinematic directional lighting with sharp subject separation",
    "vivid orange (#F97315) rim light and glow accents as dominant visual signature",
    selectedHeadshotDataUrl
      ? "use the supplied headshot as the exact identity and expression reference, preserve likeness, preserve pose intent, and make the person feel native to the scene"
      : "",
    selectedHeadshotDataUrl
      ? "match perspective, lighting direction, edge detail, shadowing, contrast, and color grade so the headshot blends seamlessly into the final artwork"
      : "",
    selectedHeadshotMeta
      ? `expression target: ${selectedHeadshotMeta.description}`
      : "",
    selectedHeadshotDataUrl
      ? "avoid sticker-cutout edges, pasted-on outlines, duplicate people, warped hands, or mismatched anatomy"
      : "",
    chosenAdditionalInstructions
      ? `user-provided additional instructions (apply explicitly unless unsafe): ${chosenAdditionalInstructions}`
      : "",
    "avoid random text, watermarks, timestamps, or UI labels unless explicitly requested",
    "1280x720 YouTube thumbnail, ultra sharp, high contrast, cinematic, minimal composition, no borders, professional art direction",
  ].filter(Boolean);

  const basePrompt = promptSegments.join(", ");
  const imagePrompt = chosenOverlay
    ? chosenAdditionalInstructions
      ? `${basePrompt}, required overlay text is exactly "${chosenOverlay}", do not add unrelated text, also follow this extra user direction exactly: "${chosenAdditionalInstructions}"`
      : `${basePrompt}, required overlay text is exactly "${chosenOverlay}" and no other words`
    : chosenAdditionalInstructions
      ? `${basePrompt}, no random text unless explicitly required by this extra user direction: "${chosenAdditionalInstructions}"`
      : `${basePrompt}, absolutely no text, letters, numbers, symbols, labels, subtitles, or captions anywhere in the image`;

  const imageResult = await callOpenRouterImage({
    prompt: imagePrompt,
    imageDataUrl: selectedHeadshotDataUrl,
  });

  const outputText = [
    "# Thumbnail Output",
    "",
    `- Format: ${chosenFormat}`,
    `- Format Rationale: ${formatReason}`,
    `- Headshot Used: ${selectedHeadshot || "No"}`,
    `- Headshot Rationale: ${headshotReason || "N/A"}`,
    `- Text Overlay: ${chosenOverlay || "No text overlay"}`,
    `- Additional Instructions: ${chosenAdditionalInstructions || "None"}`,
    "",
    "## Final Prompt",
    "",
    "```text",
    imagePrompt,
    "```",
  ].join("\n");

  return {
    agentId,
    name: agentName,
    executor: "thumbnail",
    ok: true,
    outputText,
    artifacts: [
      {
        type: "image",
        filename: `${agentId}.png`,
        dataUrl: imageResult.dataUrl || undefined,
        url: imageResult.url || undefined,
      },
    ],
  };
}

module.exports = {
  generateThumbnailResult,
};
