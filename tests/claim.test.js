// Tests the claim logic against a fake Slack (no network, no real keys). Run: node tests/claim.test.js
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

Object.assign(process.env, {
  SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test", SLACK_USER_TOKEN: "xoxp-test",
  CLAIM_USER_ID: "UME", CONTROL_CHANNEL: "CCTRL", CLAIM_CHANNELS: "CLEADS",
});
const calls = [];
let tsN = 1000;
global.fetch = async (url, opts) => {
  const method = url.split("/").pop();
  const body = JSON.parse(opts.body || "{}");
  calls.push({ method, token: opts.headers.Authorization.slice(7), body });
  return { status: 200, json: async () => ({ ok: true, ts: String(tsN++ + 0.5), messages: [] }) };
};

// Keep the real state.json untouched: point the bot at a temp copy of the repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lc-"));
fs.mkdirSync(path.join(tmp, "src"));
fs.copyFileSync(path.join(__dirname, "..", "src", "index.js"), path.join(tmp, "src", "index.js"));
const bot = require(path.join(tmp, "src", "index.js"));

const tReplies = () => calls.filter((c) => c.method === "chat.postMessage" && c.token === "xoxp-test");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lead = (extra = {}) => ({
  type: "message", channel: "CLEADS", ts: String(Date.now() / 1000), bot_id: "BAIBOT", subtype: "bot_message",
  bot_profile: { name: "AIBot" }, text: "🚨 New Lead Alert ~ n8n\nName: Gwen", ...extra,
});

(async () => {
  let n = 0;
  const test = async (name, fn) => { calls.length = 0; bot.state.armed = false; bot.state.leadBotId = null; await fn(); console.log("ok -", name); n++; };

  await test("replies exactly one 't' to an AIBot lead, then turns OFF", async () => {
    bot.arm();
    await bot.claim(lead());
    await wait(1500); // longer than any follow-up gap used to be
    assert.strictEqual(tReplies().length, 1);
    assert.strictEqual(tReplies()[0].body.text, "t");
    assert.strictEqual(tReplies()[0].body.channel, "CLEADS");
    assert.ok(tReplies()[0].body.thread_ts);
    assert.strictEqual(bot.state.armed, false);
  });

  await test("only one lead per On", async () => {
    bot.arm();
    await Promise.all([bot.claim(lead({ ts: "1.1" })), bot.claim(lead({ ts: "1.2" }))]);
    await wait(50);
    assert.strictEqual(tReplies().length, 1);
  });

  await test("ignores messages from people", async () => {
    bot.arm();
    await bot.claim({ type: "message", channel: "CLEADS", ts: "2.1", user: "USOMEONE", text: "New Lead Alert" });
    assert.strictEqual(tReplies().length, 0);
    assert.strictEqual(bot.state.armed, true);
  });

  await test("ignores other apps", async () => {
    bot.arm();
    await bot.claim(lead({ bot_id: "BOTHER", bot_profile: { name: "Zapier" } }));
    assert.strictEqual(tReplies().length, 0);
    assert.strictEqual(bot.state.armed, true);
  });

  await test("ignores AIBot messages that are not a New Lead Alert", async () => {
    bot.arm();
    await bot.claim(lead({ text: "Daily summary: 12 leads today" }));
    assert.strictEqual(tReplies().length, 0);
    assert.strictEqual(bot.state.armed, true);
  });

  await test("finds the alert text inside Slack blocks", async () => {
    bot.arm();
    await bot.claim(lead({ text: "", blocks: [{ type: "section", text: { type: "mrkdwn", text: ":rotating_light: New Lead Alert ~ n8n" } }] }));
    assert.strictEqual(tReplies().length, 1);
  });

  await test("never replies to Jase Chijioke and stays ON", async () => {
    bot.arm();
    await bot.claim(lead({ text: "New Lead Alert ~ n8n\nName: Jase Chijioke" }));
    assert.strictEqual(tReplies().length, 0);
    assert.strictEqual(bot.state.armed, true);
  });

  await test("does nothing while OFF", async () => {
    await bot.claim(lead());
    assert.strictEqual(tReplies().length, 0);
  });

  await test("does not reply in other channels", async () => {
    bot.arm();
    await bot.claim(lead({ channel: "CRANDOM" }));
    assert.strictEqual(tReplies().length, 0);
  });

  await test("after locking to AIBot's app ID, a different app named AIBot is ignored", async () => {
    bot.state.leadBotId = "BAIBOT";
    bot.arm();
    await bot.claim(lead({ bot_id: "BFAKE" }));
    assert.strictEqual(tReplies().length, 0);
  });

  console.log(`\nAll ${n} tests passed.`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
