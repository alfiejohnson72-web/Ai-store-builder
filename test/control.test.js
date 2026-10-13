const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBot, flush } = require("./helpers");

let n = 0;
const msg = (text, extra = {}) => ({ type: "message", channel: "CCONTROL", user: "UME", ts: `1.${String(++n).padStart(6, "0")}`, text, ...extra });
const said = (slack) => slack.posts("xoxb-1").map((c) => c.body.text || "");

test("only you are obeyed", async () => {
  const { bot, state } = makeBot();
  bot.control.handle(msg("on", { user: "USOMEONE" }));
  bot.control.handle(msg("on", { bot_id: "B1" }));
  assert.equal(state.armed, false);
  bot.control.handle(msg("on"));
  assert.equal(state.armed, true);
  bot.control.handle(msg("off"));
  assert.equal(state.armed, false);
});

test("the same command delivered twice runs once", async () => {
  const { bot, state } = makeBot();
  const m = msg("watch <#CNEW|leads-2>");
  bot.control.handle(m);
  bot.control.handle({ ...m });
  assert.deepEqual(state.channels, ["CLEADS", "CNEW"]);
});

test("watch and unwatch", () => {
  const { bot, state } = makeBot();
  bot.control.handle(msg("watch <#CA> <#CB|b>"));
  assert.deepEqual(state.channels, ["CLEADS", "CA", "CB"]);
  bot.control.handle(msg("unwatch <#CLEADS|x>"));
  assert.deepEqual(state.channels, ["CA", "CB"]);
});

test("ignore and unignore by mention or name", () => {
  const { bot, state } = makeBot();
  bot.control.handle(msg("ignore <@UBAD> Pat Doe"));
  assert.deepEqual(state.ignoredUsers, ["UBAD"]);
  assert.deepEqual(state.ignoredNames, ["Pat Doe"]);
  bot.control.handle(msg("unignore <@UBAD> pat doe"));
  assert.deepEqual(state.ignoredUsers, []);
  assert.deepEqual(state.ignoredNames, []);
});

test("delay switches between instant and timed replies", () => {
  const { bot, state, slack } = makeBot({ env: { REPLY_DELAY_MS: "800" } });
  assert.equal(bot.claimer.delayMs(), 800);
  bot.control.handle(msg("delay instant"));
  assert.equal(bot.claimer.delayMs(), 0);
  bot.control.handle(msg("delay 750ms"));
  assert.equal(bot.claimer.delayMs(), 750);
  bot.control.handle(msg("delay default"));
  assert.equal(state.delayMs, null);
  assert.equal(bot.claimer.delayMs(), 800);
  bot.control.handle(msg("delay 99999"));
  assert.ok(said(slack).some((t) => /^Type: delay/.test(t)));
});

test("On/Off buttons work only for you", () => {
  const { bot, state } = makeBot();
  bot.control.handleButton({ user: { id: "USOMEONE" }, actions: [{ action_id: "on" }] });
  assert.equal(state.armed, false);
  bot.control.handleButton({ user: { id: "UME" }, actions: [{ action_id: "on" }] });
  assert.equal(state.armed, true);
  bot.control.handleButton({ user: { id: "UME" }, actions: [{ action_id: "off" }] });
  assert.equal(state.armed, false);
});

test("only one panel is kept: each refresh deletes the previous one", async () => {
  const { bot, slack, state } = makeBot();
  await bot.panel.refresh();
  const first = state.panelTs;
  await new Promise((r) => setTimeout(r, 2));
  await bot.panel.refresh();
  await flush();
  assert.notEqual(state.panelTs, first);
  assert.ok(slack.calls.some((c) => c.method === "chat.delete" && c.body.ts === first));
});
