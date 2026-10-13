// Test helpers: a fake Slack that records every call, and a bot wired to it with no real waiting.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { createBot } = require("../src/bot");

const ENV = {
  SLACK_APP_TOKEN: "xapp-1",
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_USER_TOKEN: "xoxp-1",
  CLAIM_USER_ID: "UME",
  CONTROL_CHANNEL: "CCONTROL",
  CLAIM_CHANNELS: "CLEADS",
};

function fakeSlack(handlers = {}) {
  const calls = [];
  const clock = { offset: 0, minRtt: Infinity, slackNow: () => Date.now() };
  async function call(method, token, body = {}) {
    calls.push({ method, token, body });
    if (handlers[method]) return handlers[method](body, calls);
    if (method === "chat.postMessage") return { ok: true, ts: (Date.now() / 1000).toFixed(6) };
    return { ok: true, messages: [] };
  }
  const posts = (token) => calls.filter((c) => c.method === "chat.postMessage" && (!token || c.token === token));
  return { call, clock, calls, posts };
}

function makeBot({ env = {}, handlers, rand = () => 0.5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claimer-"));
  const config = loadConfig({ ...ENV, STATE_FILE: path.join(dir, "state.json"), ...env });
  const slack = fakeSlack(handlers);
  const sleeps = [];
  const bot = createBot(config, { slack, log: () => {}, sleep: async (ms) => { sleeps.push(ms); }, rand });
  return { bot, slack, config, sleeps, state: bot.store.state };
}

const nowTs = () => (Date.now() / 1000).toFixed(6);
const lead = (extra = {}) => ({ type: "message", channel: "CLEADS", ts: nowTs(), subtype: "bot_message", bot_id: "BAI", bot_profile: { name: "AIBot" }, text: "New lead alert", ...extra });
const flush = () => new Promise((r) => setImmediate(r));

module.exports = { ENV, fakeSlack, makeBot, lead, nowTs, flush };
