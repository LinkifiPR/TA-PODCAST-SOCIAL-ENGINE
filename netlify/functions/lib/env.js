const fs = require("fs");
const path = require("path");
const { candidateRoots } = require("./agents");

function loadEnvFile(filename = ".env") {
  const tried = [];

  for (const root of candidateRoots()) {
    const envPath = path.resolve(root, filename);
    tried.push(envPath);
    if (!fs.existsSync(envPath)) continue;

    const text = fs.readFileSync(envPath, "utf8");
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();

      const eqIndex = line.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
    return;
  }
}

module.exports = { loadEnvFile };
