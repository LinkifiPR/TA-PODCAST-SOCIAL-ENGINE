const { loadPrompt } = require("./agents");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ALLOWED_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

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

function normalizeReasoningEffort(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "low";
  if (raw === "minimal") return "low";
  if (ALLOWED_REASONING_EFFORTS.has(raw)) return raw;
  return "low";
}

async function callOpenAI({ model, systemPrompt, userPrompt, maxOutputTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on this environment.");
  }

  const reasoningEffort = normalizeReasoningEffort(
    process.env.OPENAI_REASONING_EFFORT
  );
  const tokens = Number(
    maxOutputTokens || process.env.OPENAI_MAX_OUTPUT_TOKENS || 2200
  );

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort },
      max_output_tokens: Number.isFinite(tokens) ? tokens : 2200,
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

async function generateTextAgentResult({
  agent,
  sourceText,
  videoUrl,
  request,
}) {
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

module.exports = {
  generateTextAgentResult,
};
