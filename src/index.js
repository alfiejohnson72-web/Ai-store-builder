// Launcher: downloads the newest bot code from GitHub on every start, then runs it.
// If GitHub can't be reached, it runs the last downloaded copy.
const fs = require("node:fs");
const path = require("node:path");

const URL = "https://raw.githubusercontent.com/alfiejohnson72-web/Ai-store-builder/claude/intelligent-turing-0qpxxz/src/bot.js";
const file = path.join(__dirname, "bot.js");

(async () => {
  try {
    const res = await fetch(`${URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("LEAD-CLAIMER-BOT") && (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text)) {
        fs.writeFileSync(file, text);
        console.log("Downloaded the latest bot code.");
      }
    }
  } catch (err) {
    console.log("Could not check for updates:", err.message);
  }
  if (!fs.existsSync(file)) {
    console.error("bot.js is missing and could not be downloaded. Check your internet and try again.");
    process.exit(1);
  }
  require(file);
})();
