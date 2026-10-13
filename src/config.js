// Reads and checks the settings from .env (or Render's environment). Swapped bot/user keys are fixed automatically.
const path = require("node:path");

const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "");

function loadConfig(env = process.env) {
  const get = (k) => clean(env[k]);
  let botToken = get("SLACK_BOT_TOKEN");
  let userToken = get("SLACK_USER_TOKEN");
  if (botToken.startsWith("xoxp-") && userToken.startsWith("xoxb-")) [botToken, userToken] = [userToken, botToken]; // pasted the wrong way round

  const config = {
    appToken: get("SLACK_APP_TOKEN"),
    botToken,
    userToken,
    userId: get("CLAIM_USER_ID"),
    controlChannel: get("CONTROL_CHANNEL"),
    channels: get("CLAIM_CHANNELS").split(",").map((s) => s.trim()).filter(Boolean),
    leadBotName: (get("LEAD_BOT_NAME") || "AIBot").toLowerCase(), // the app that posts your lead alerts
    replyDelayMs: get("REPLY_DELAY_MS") ? Number(get("REPLY_DELAY_MS")) : 0, // 0 = reply the instant the lead arrives
    matcher: null,
    stateFile: get("STATE_FILE") || path.join(__dirname, "..", "state.json"),
  };

  const problems = [];
  if (!config.appToken.startsWith("xapp-")) problems.push("SLACK_APP_TOKEN must start with xapp-");
  if (!config.botToken.startsWith("xoxb-")) problems.push("SLACK_BOT_TOKEN must start with xoxb-");
  if (!config.userToken.startsWith("xoxp-")) problems.push("SLACK_USER_TOKEN must start with xoxp-");
  if (!/^U[A-Z0-9]+$/.test(config.userId)) problems.push("CLAIM_USER_ID must look like U0123ABCDEF");
  if (!/^[CG][A-Z0-9]+$/.test(config.controlChannel)) problems.push("CONTROL_CHANNEL must look like C0123ABCDEF");
  if (!isValidDelay(config.replyDelayMs)) problems.push(`REPLY_DELAY_MS must be a whole number from 0 to ${MAX_DELAY_MS}`);
  try {
    if (get("CLAIM_MATCH")) config.matcher = new RegExp(get("CLAIM_MATCH"), "i");
  } catch {
    problems.push("CLAIM_MATCH is not a valid pattern");
  }
  if (problems.length) throw new Error("Fix your .env file:\n - " + problems.join("\n - "));
  return config;
}

const MAX_DELAY_MS = 3000;
const isValidDelay = (ms) => Number.isInteger(ms) && ms >= 0 && ms <= MAX_DELAY_MS;

module.exports = { loadConfig, isValidDelay, MAX_DELAY_MS };
