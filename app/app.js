const form = document.getElementById("run-form");
const sourceTextEl = document.getElementById("sourceText");
const videoUrlEl = document.getElementById("videoUrl");
const requestEl = document.getElementById("request");
const headshotFileEl = document.getElementById("headshotFile");
const runButton = document.getElementById("runButton");
const statusText = document.getElementById("statusText");
const agentsList = document.getElementById("agentsList");
const thumbnailSetupEl = document.getElementById("thumbnailSetup");
const thumbnailFormatEl = document.getElementById("thumbnailFormat");
const thumbnailFormatHintEl = document.getElementById("thumbnailFormatHint");
const thumbnailOverlayEl = document.getElementById("thumbnailOverlay");
const thumbnailHeadshotHintEl = document.getElementById("thumbnailHeadshotHint");
const thumbnailHeadshotQuestionWrapEl = document.getElementById(
  "thumbnailHeadshotQuestionWrap"
);
const thumbnailHeadshotChoiceNoteEl = document.getElementById(
  "thumbnailHeadshotChoiceNote"
);
const thumbnailHeadshotAutoWrapEl = document.getElementById(
  "thumbnailHeadshotAutoWrap"
);
const resultSummary = document.getElementById("resultSummary");
const resultsWrap = document.getElementById("results");
const resultCardTemplate = document.getElementById("resultCardTemplate");

let availableAgents = [];
let thumbnailOptions = null;
let thumbnailOptionsTimer = null;
const THUMBNAIL_POLL_INTERVAL_MS = 2500;
const THUMBNAIL_POLL_TIMEOUT_MS = 8 * 60 * 1000;
const BACKGROUND_AGENT_IDS = new Set(["yt-intro-title-description"]);
const MAX_HEADSHOT_UPLOAD_BYTES = 2.25 * 1024 * 1024;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "var(--err)" : "var(--muted)";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read uploaded file."));
    reader.readAsDataURL(file);
  });
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function assertHeadshotUploadSize(dataUrl) {
  const estimatedBytes = estimateDataUrlBytes(dataUrl);
  if (estimatedBytes <= MAX_HEADSHOT_UPLOAD_BYTES) {
    return dataUrl;
  }
  throw new Error(
    "Uploaded headshot is too large. Use a JPG/PNG under ~2MB for reliable generation."
  );
}

async function fileToOptimizedDataUrl(file) {
  const originalDataUrl = await fileToDataUrl(file);

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode uploaded image."));
      image.src = originalDataUrl;
    });

    const maxDimension = 1024;
    const scale = Math.min(
      1,
      maxDimension / Math.max(img.width || 1, img.height || 1)
    );
    const targetWidth = Math.max(1, Math.round((img.width || 1) * scale));
    const targetHeight = Math.max(1, Math.round((img.height || 1) * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return assertHeadshotUploadSize(originalDataUrl);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    const qualities = [0.86, 0.76, 0.66];
    for (const quality of qualities) {
      const candidate = canvas.toDataURL("image/jpeg", quality);
      if (estimateDataUrlBytes(candidate) <= MAX_HEADSHOT_UPLOAD_BYTES) {
        return candidate;
      }
    }
    return assertHeadshotUploadSize(canvas.toDataURL("image/jpeg", 0.6));
  } catch (err) {
    if (estimateDataUrlBytes(originalDataUrl) > MAX_HEADSHOT_UPLOAD_BYTES) {
      throw new Error(
        "Could not optimize this upload and the original file is too large. Please use a smaller JPG/PNG headshot."
      );
    }
    return assertHeadshotUploadSize(originalDataUrl);
  }
}

function selectedAgents() {
  const checked = Array.from(
    agentsList.querySelectorAll("input[type='checkbox']:checked")
  );
  return checked.map((el) => el.value);
}

function isThumbnailSelected() {
  return selectedAgents().includes("yt-thumbnail-generator");
}

function renderAgents(agents) {
  agentsList.innerHTML = "";

  if (!agents.length) {
    agentsList.textContent = "No enabled agents found.";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const agent of agents) {
    const row = document.createElement("label");
    row.className = "agent-option";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = agent.id;
    check.checked = true;

    const text = document.createElement("span");
    text.textContent = `${agent.name} (${agent.executor})`;

    row.append(check, text);
    fragment.appendChild(row);
  }

  agentsList.appendChild(fragment);
  agentsList.addEventListener("change", () => {
    updateThumbnailSetupVisibility();
  });
}

function renderSummary(payload) {
  resultSummary.classList.remove("hidden");
  resultSummary.innerHTML = `
    <div>
      <h2 class="summary-title">Run Complete</h2>
      <p class="summary-meta">Run ID: ${payload.runId}</p>
    </div>
    <div class="summary-meta">
      Agents: ${payload.totalAgents} • Failed: ${payload.failedAgents} • Generated: ${new Date(
        payload.generatedAt
      ).toLocaleString()}
    </div>
  `;
}

function renderArtifactImage(artifact) {
  const wrap = document.createElement("div");
  const src = artifact.dataUrl || artifact.url || "";
  if (!src) return wrap;

  const img = document.createElement("img");
  img.src = src;
  img.alt = artifact.filename || "Generated thumbnail";
  img.className = "artifact-image";

  const link = document.createElement("a");
  link.href = src;
  if (artifact.dataUrl) {
    link.download = artifact.filename || "thumbnail.png";
    link.textContent = `Download ${artifact.filename || "image"}`;
  } else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open generated image";
  }
  link.className = "artifact-link";

  wrap.append(img, link);
  return wrap;
}

function renderResults(results) {
  resultsWrap.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const result of results) {
    const card = resultCardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".result-title").textContent = result.name || result.agentId;

    const pill = card.querySelector(".result-pill");
    pill.textContent = result.ok ? "SUCCESS" : "ERROR";
    pill.classList.add(result.ok ? "ok" : "err");

    const output = card.querySelector(".output-text");
    output.textContent = result.ok
      ? result.outputText || "(No output text returned)"
      : result.error || "Unknown error";

    const artifactWrap = card.querySelector(".artifact-wrap");
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    for (const artifact of artifacts) {
      if (artifact?.type === "image" && (artifact?.dataUrl || artifact?.url)) {
        artifactWrap.appendChild(renderArtifactImage(artifact));
      }
    }

    fragment.appendChild(card);
  }

  resultsWrap.appendChild(fragment);
}

function getAgentLabel(agentId) {
  const match = availableAgents.find((agent) => agent.id === agentId);
  return match ? match.name : agentId;
}

function syncHeadshotModeUi() {
  const yesRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='yes']"
  );
  const noRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='no']"
  );
  if (!yesRadio || !noRadio) return;

  const hasUpload = Boolean(headshotFileEl.files?.[0]);
  if (hasUpload) {
    yesRadio.checked = true;
    noRadio.checked = false;
    thumbnailHeadshotQuestionWrapEl?.classList.add("hidden");
    thumbnailHeadshotChoiceNoteEl?.classList.add("hidden");
    thumbnailHeadshotAutoWrapEl?.classList.remove("hidden");
    return;
  }

  thumbnailHeadshotQuestionWrapEl?.classList.remove("hidden");
  thumbnailHeadshotChoiceNoteEl?.classList.remove("hidden");
  thumbnailHeadshotAutoWrapEl?.classList.add("hidden");
}

function updateHeadshotHint() {
  const hasUpload = Boolean(headshotFileEl.files?.[0]);
  const selectedMode = document.querySelector(
    "input[name='thumbnailHeadshotMode']:checked"
  );

  if (hasUpload) {
    thumbnailHeadshotHintEl.textContent =
      "Uploaded headshot will be used automatically for this run.";
    return;
  }

  if (selectedMode?.value === "no") {
    thumbnailHeadshotHintEl.textContent =
      "Headshots are disabled for this thumbnail run.";
    return;
  }

  if ((thumbnailOptions?.availableHeadshotCount || 0) > 0) {
    thumbnailHeadshotHintEl.textContent =
      "The app will auto-pick the best saved headshot for the selected format.";
    return;
  }

  thumbnailHeadshotHintEl.textContent =
    "No saved headshots are available, so choose 'No' unless you upload one above.";
}

function renderThumbnailOptions(options) {
  thumbnailOptions = options;

  thumbnailFormatEl.innerHTML = "";
  for (const format of options.formats || []) {
    const opt = document.createElement("option");
    opt.value = format;
    opt.textContent = format;
    if (format === options.recommendedFormat) opt.selected = true;
    thumbnailFormatEl.appendChild(opt);
  }

  const altFormats = Array.isArray(options.alternatives)
    ? options.alternatives.filter(Boolean)
    : [];
  const altLabel = altFormats.length
    ? ` Alternatives: ${altFormats.join(" • ")}.`
    : "";
  thumbnailFormatHintEl.textContent = `Recommended: ${options.recommendedFormat}. ${options.recommendedReason}${altLabel}`;

  const yesRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='yes']"
  );
  const noRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='no']"
  );

  const hasUpload = Boolean(headshotFileEl.files?.[0]);
  if (hasUpload) {
    yesRadio.checked = true;
    noRadio.checked = false;
  } else {
    const recommendedIncludeHeadshot = options.includeHeadshotRecommended === true;
    yesRadio.checked = recommendedIncludeHeadshot;
    noRadio.checked = !recommendedIncludeHeadshot;
  }
  syncHeadshotModeUi();
  updateHeadshotHint();

  thumbnailOverlayEl.value = options.suggestedOverlayText || "";
}

async function loadThumbnailOptions() {
  const sourceText = sourceTextEl.value.trim();
  if (!sourceText) {
    thumbnailFormatHintEl.textContent = "Paste transcript first to get recommendations.";
    return;
  }

  const response = await fetch("/api/thumbnail-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: sourceText,
      request: requestEl.value.trim(),
    }),
  });
  const payload = await parseApiResponse(response);
  renderThumbnailOptions(payload);
}

async function updateThumbnailSetupVisibility() {
  if (!isThumbnailSelected()) {
    thumbnailSetupEl.classList.add("hidden");
    return;
  }

  thumbnailSetupEl.classList.remove("hidden");
  try {
    await loadThumbnailOptions();
  } catch (err) {
    thumbnailFormatHintEl.textContent =
      err.message || "Could not load thumbnail recommendations.";
  }
}

function getThumbnailConfig() {
  const hasUpload = Boolean(headshotFileEl.files?.[0]);
  const selectedMode = document.querySelector(
    "input[name='thumbnailHeadshotMode']:checked"
  );
  if (!hasUpload && !selectedMode) {
    throw new Error("Please answer the thumbnail question: use a headshot or not.");
  }

  const overlay = thumbnailOverlayEl.value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return {
    formatName: thumbnailFormatEl.value || thumbnailOptions?.recommendedFormat || "ACCUSATION",
    includeHeadshot: hasUpload ? true : selectedMode.value === "yes",
    autoHeadshot: thumbnailOptions?.recommendedHeadshot || "",
    textOverlay: overlay,
  };
}

function queueThumbnailRefresh() {
  if (!isThumbnailSelected()) return;
  clearTimeout(thumbnailOptionsTimer);
  thumbnailOptionsTimer = setTimeout(() => {
    updateThumbnailSetupVisibility();
  }, 450);
}

async function parseApiResponse(response) {
  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    if (raw.includes("Sandbox.Timedout")) {
      throw new Error(
        "Thumbnail generation timed out on Netlify (30s limit). Re-run the thumbnail agent by itself, and use a smaller uploaded headshot if possible."
      );
    }
    const detail =
      (payload && (payload.error || payload.message)) ||
      raw.slice(0, 220) ||
      "Request failed";
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  if (!payload || payload.ok !== true) {
    const detail =
      (payload && (payload.error || payload.message)) || "Run failed.";
    throw new Error(detail);
  }

  return payload;
}

async function runSingleAgent(payloadBase, agentId) {
  const textPayloadBase = {
    transcript: payloadBase.transcript,
    videoUrl: payloadBase.videoUrl,
    request: payloadBase.request,
  };

  if (agentId === "yt-thumbnail-generator") {
    return runThumbnailJob(payloadBase);
  }
  if (BACKGROUND_AGENT_IDS.has(agentId)) {
    return runAgentJob(textPayloadBase, agentId);
  }

  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...textPayloadBase,
      selectedAgents: [agentId],
    }),
  });

  const payload = await parseApiResponse(response);
  const result = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!result) {
    throw new Error(`No result returned for ${agentId}.`);
  }
  return result;
}

async function runAgentJob(payloadBase, agentId) {
  const startResponse = await fetch("/api/agent-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payloadBase,
      selectedAgents: [agentId],
    }),
  });

  const startPayload = await parseApiResponse(startResponse);
  const jobId = String(startPayload.jobId || "").trim();
  if (!jobId) {
    throw new Error("Background agent job did not return an id.");
  }

  const deadline = Date.now() + THUMBNAIL_POLL_TIMEOUT_MS;
  setStatus(`${getAgentLabel(agentId)} queued...`);

  while (Date.now() < deadline) {
    await sleep(THUMBNAIL_POLL_INTERVAL_MS);
    const pollResponse = await fetch(
      `/api/agent-job?jobId=${encodeURIComponent(jobId)}`,
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
    if (pollResponse.status === 404) {
      continue;
    }
    const pollPayload = await parseApiResponse(pollResponse);
    const status = String(pollPayload.status || "queued");

    if (status === "completed") {
      if (!pollPayload.result || pollPayload.result.ok !== true) {
        throw new Error("Background agent job completed without a valid result.");
      }
      return pollPayload.result;
    }

    if (status === "failed") {
      throw new Error(pollPayload.error || "Background agent generation failed.");
    }

    setStatus(`Generating ${getAgentLabel(agentId)} in background...`);
  }

  throw new Error(
    `${getAgentLabel(agentId)} is still running in the background. Wait a moment and try again if needed.`
  );
}

async function runThumbnailJob(payloadBase) {
  const startResponse = await fetch("/api/thumbnail-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadBase),
  });

  const startPayload = await parseApiResponse(startResponse);
  const jobId = String(startPayload.jobId || "").trim();
  if (!jobId) {
    throw new Error("Thumbnail job did not return an id.");
  }

  const deadline = Date.now() + THUMBNAIL_POLL_TIMEOUT_MS;
  let status = String(startPayload.status || "queued");
  setStatus("Thumbnail queued. Generating in background...");

  while (Date.now() < deadline) {
    await sleep(THUMBNAIL_POLL_INTERVAL_MS);
    const pollResponse = await fetch(
      `/api/thumbnail-job?jobId=${encodeURIComponent(jobId)}`,
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
    if (pollResponse.status === 404) {
      continue;
    }
    const pollPayload = await parseApiResponse(pollResponse);
    status = String(pollPayload.status || "queued");

    if (status === "completed") {
      if (!pollPayload.result || pollPayload.result.ok !== true) {
        throw new Error("Thumbnail job completed without a valid result.");
      }
      return pollPayload.result;
    }

    if (status === "failed") {
      throw new Error(pollPayload.error || "Thumbnail generation failed.");
    }

    setStatus("Generating thumbnail in background...");
  }

  throw new Error(
    "Thumbnail generation is still running in the background. Wait a moment and run the thumbnail again if needed."
  );
}

async function loadAgents() {
  try {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to load agents.");
    }
    availableAgents = payload.agents || [];
    renderAgents(availableAgents);
    await updateThumbnailSetupVisibility();
  } catch (err) {
    setStatus(err.message || "Could not load agents.", true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const sourceText = sourceTextEl.value.trim();
  if (!sourceText) {
    setStatus("Please paste a transcript or topic first.", true);
    return;
  }

  const chosenAgents = selectedAgents();
  if (!chosenAgents.length) {
    setStatus("Select at least one agent.", true);
    return;
  }

  runButton.disabled = true;
  setStatus("Running agents...");
  resultSummary.classList.add("hidden");
  resultsWrap.innerHTML = "";

  try {
    const rawVideoUrl = videoUrlEl.value.trim();
    const videoUrl =
      rawVideoUrl && !/^https?:\/\//i.test(rawVideoUrl)
        ? `https://${rawVideoUrl}`
        : rawVideoUrl;

    let headshotDataUrl = null;
    let headshotFilename = null;
    const file = headshotFileEl.files?.[0];
    if (file) {
      headshotDataUrl = await fileToOptimizedDataUrl(file);
      headshotFilename = file.name;
    }

    let thumbnailConfig = null;
    if (chosenAgents.includes("yt-thumbnail-generator")) {
      if (!thumbnailOptions) {
        await loadThumbnailOptions();
      }
      thumbnailConfig = getThumbnailConfig();
    }

    const payloadBase = {
      transcript: sourceText,
      videoUrl,
      request: requestEl.value.trim(),
      headshotDataUrl,
      headshotFilename,
      thumbnailConfig,
    };

    const results = [];
    for (let index = 0; index < chosenAgents.length; index += 1) {
      const agentId = chosenAgents[index];
      setStatus(`Running ${index + 1}/${chosenAgents.length}: ${getAgentLabel(agentId)}...`);
      try {
        const result = await runSingleAgent(payloadBase, agentId);
        results.push(result);
      } catch (err) {
        results.push({
          agentId,
          name: getAgentLabel(agentId),
          ok: false,
          error: err.message || "Run failed.",
          outputText: "",
          artifacts: [],
        });
      }
    }

    const failedAgents = results.filter((result) => !result.ok).length;
    const summary = {
      runId: new Date().toISOString().replace(/[:.]/g, "-"),
      generatedAt: new Date().toISOString(),
      totalAgents: results.length,
      failedAgents,
    };

    renderSummary(summary);
    renderResults(results);

    if (failedAgents > 0) {
      setStatus(`Completed with ${failedAgents} failed agent(s).`, true);
    } else {
      setStatus("All agents completed successfully.");
    }
  } catch (err) {
    setStatus(err.message || "Unexpected error during run.", true);
  } finally {
    runButton.disabled = false;
  }
});

sourceTextEl.addEventListener("blur", queueThumbnailRefresh);
sourceTextEl.addEventListener("input", queueThumbnailRefresh);

requestEl.addEventListener("blur", queueThumbnailRefresh);
requestEl.addEventListener("input", queueThumbnailRefresh);

headshotFileEl.addEventListener("change", () => {
  syncHeadshotModeUi();
  updateHeadshotHint();
  if (isThumbnailSelected() && thumbnailOptions) {
    renderThumbnailOptions(thumbnailOptions);
  }
});

thumbnailFormatEl.addEventListener("change", updateHeadshotHint);
document
  .querySelectorAll("input[name='thumbnailHeadshotMode']")
  .forEach((input) => input.addEventListener("change", updateHeadshotHint));

syncHeadshotModeUi();
loadAgents();
