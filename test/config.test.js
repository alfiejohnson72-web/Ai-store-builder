const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { ENV } = require("./helpers");

test("reads a good .env, trimming quotes and spaces", () => {
  const c = loadConfig({ ...ENV, SLACK_APP_TOKEN: ' "xapp-1" ', CLAIM_CHANNELS: "C1, C2,", CLAIM_MATCH: "lead" });
  assert.equal(c.appToken, "xapp-1");
  assert.deepEqual(c.channels, ["C1", "C2"]);
  assert.equal(c.leadBotName, "aibot");
  assert.equal(c.replyDelayMs, 0);
  assert.ok(c.matcher.test("New LEAD"));
});

test("fixes bot and user keys pasted the wrong way round", () => {
  const c = loadConfig({ ...ENV, SLACK_BOT_TOKEN: "xoxp-9", SLACK_USER_TOKEN: "xoxb-9" });
  assert.equal(c.botToken, "xoxb-9");
  assert.equal(c.userToken, "xoxp-9");
});

test("lists every problem at once", () => {
  assert.throws(
    () => loadConfig({ ...ENV, SLACK_APP_TOKEN: "nope", CLAIM_USER_ID: "x", CLAIM_MATCH: "(", REPLY_DELAY_MS: "abc" }),
    (e) => /xapp-/.test(e.message) && /CLAIM_USER_ID/.test(e.message) && /CLAIM_MATCH/.test(e.message) && /REPLY_DELAY_MS/.test(e.message),
  );
});
