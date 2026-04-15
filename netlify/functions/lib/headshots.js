const fs = require("fs/promises");
const path = require("path");

const BUNDLED_HEADSHOTS_DIR = path.resolve(__dirname, "../../../headshots");
const manifest = require(path.join(BUNDLED_HEADSHOTS_DIR, "manifest.json"));

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const HEADSHOT_LIBRARY = Array.isArray(manifest.headshots)
  ? manifest.headshots.map((entry) => ({
      ...entry,
      bestFormats: Array.isArray(entry.bestFormats)
        ? entry.bestFormats.map((format) => String(format || "").trim().toUpperCase())
        : [],
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : [],
    }))
  : [];

const FORMAT_PREFERENCES = {
  "TITLE HEAD": ["confident", "pointing"],
  "DRAMATIC FACE": ["complete-shock", "shocked", "surprised"],
  "A AFFECTS B": ["pointing", "surprised", "confident"],
  "CONVERSATION QUESTION": ["confident", "pointing"],
  "3-PANEL PROGRESS": ["confident", "surprised"],
  "PROBLEM STATE": ["disappointed", "complete-shock", "shocked"],
  CONTRAST: ["pointing", "confident", "surprised"],
  "DON'T DO THIS": ["pointing", "disappointed"],
  ELIMINATORS: ["confident", "pointing"],
  "MOTION ARROW": ["pointing", "surprised"],
  CONFLICT: ["confident", "pointing"],
  "MID PROGRESSION": ["confident", "surprised"],
  "COMMENT / POST": ["complete-shock", "shocked", "disappointed"],
  ACCUSATION: ["pointing", "disappointed"],
  REVIEW: ["surprised", "complete-shock", "shocked"],
};

async function directoryExists(targetDir) {
  if (!targetDir) return false;
  try {
    const stat = await fs.stat(targetDir);
    return stat.isDirectory();
  } catch (_) {
    return false;
  }
}

async function resolveHeadshotsDir(configuredDir) {
  const preferred = String(configuredDir || "").trim();
  if (preferred && (await directoryExists(preferred))) {
    return path.resolve(preferred);
  }
  return BUNDLED_HEADSHOTS_DIR;
}

async function scanImageFiles(targetDir) {
  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

function matchLibraryEntry(entry, files) {
  const fileMap = new Map(files.map((name) => [name.toLowerCase(), name]));
  const wanted = [entry.filename, ...entry.aliases]
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);

  for (const name of wanted) {
    if (fileMap.has(name)) return fileMap.get(name);
  }
  return null;
}

async function listAvailableHeadshots(configuredDir) {
  const directory = await resolveHeadshotsDir(configuredDir);
  const files = await scanImageFiles(directory);
  const headshots = HEADSHOT_LIBRARY.map((entry) => {
    const actualFilename = matchLibraryEntry(entry, files);
    if (!actualFilename) return null;
    return {
      ...entry,
      actualFilename,
      fullPath: path.join(directory, actualFilename),
    };
  }).filter(Boolean);

  return { directory, headshots };
}

function resolveHeadshotName(requestedName, availableHeadshots) {
  const wanted = String(requestedName || "").trim().toLowerCase();
  if (!wanted) return null;

  for (const headshot of availableHeadshots) {
    const candidates = [
      headshot.actualFilename,
      headshot.filename,
      headshot.id,
      ...(Array.isArray(headshot.aliases) ? headshot.aliases : []),
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);

    if (candidates.includes(wanted)) {
      return headshot.actualFilename;
    }
  }

  return null;
}

function findHeadshotByName(requestedName, availableHeadshots) {
  const resolved = resolveHeadshotName(requestedName, availableHeadshots);
  if (!resolved) return null;
  return availableHeadshots.find((headshot) => headshot.actualFilename === resolved) || null;
}

function pickHeadshotForFormat(formatName, availableHeadshots) {
  const normalizedFormat = String(formatName || "").trim().toUpperCase();
  const preferredIds = FORMAT_PREFERENCES[normalizedFormat] || [
    "confident",
    "pointing",
    "surprised",
    "shocked",
  ];

  for (const id of preferredIds) {
    const match = availableHeadshots.find((headshot) => headshot.id === id);
    if (match) return match;
  }

  return availableHeadshots[0] || null;
}

function formatHeadshotLibraryForPrompt(availableHeadshots) {
  if (!availableHeadshots.length) return "No saved headshots are available.";
  return availableHeadshots
    .map((headshot) => {
      const formats = headshot.bestFormats.length
        ? ` Best formats: ${headshot.bestFormats.join(", ")}.`
        : "";
      return `- ${headshot.actualFilename}: ${headshot.description}.${formats}`;
    })
    .join("\n");
}

module.exports = {
  BUNDLED_HEADSHOTS_DIR,
  HEADSHOT_LIBRARY,
  formatHeadshotLibraryForPrompt,
  findHeadshotByName,
  listAvailableHeadshots,
  pickHeadshotForFormat,
  resolveHeadshotName,
  resolveHeadshotsDir,
};
