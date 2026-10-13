const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBot, lead, flush, nowTs } = require("./helpers");

const event = (e) => ({ type: "events_api", payload: { event: e } });
const claimReplies = (slack) => slack.posts("xoxp-1").filter((c) => c.body.text === "t");

test("does nothing while OFF", async () => {
  const { bot, slack } = makeBot();
  assert.equal(await bot.claimer.claim(lead()), false);
  assert.equal(claimReplies(slack).length, 0);
});

test("claims the next lead as you, in its thread, then turns OFF", async () => {
  const { bot, slack, state } = makeBot({ rand: () => 0.7 }); // 3 t's
  bot.claimer.arm();
  const l = lead();
  assert.equal(await bot.claimer.claim(l), true);
  await flush();
  const replies = claimReplies(slack);
  assert.equal(replies.length, 3);
  assert.deepEqual(replies[0].body, { channel: "CLEADS", thread_ts: l.ts, text: "t" });
  assert.equal(state.armed, false);
  assert.equal(state.leadBotId, "BAI");
  assert.ok(slack.posts("xoxb-1").some((c) => /Claimed 1 lead/.test(c.body.text || "")));
  assert.equal(await bot.claimer.claim(lead()), false); // the next one waits for On again
});

test("the same lead delivered twice at once is claimed once", async () => {
  const { bot, slack } = makeBot({ rand: () => 0.1 });
  bot.claimer.arm();
  const l = lead();
  bot.handleMessage(event(l));
  bot.handleMessage(event({ ...l })); // bot event + user event
  await flush();
  assert.equal(claimReplies(slack).length, 1);
});

test("ignores people, other apps, replies, other channels and the never-reply list, and stays ON", async () => {
  const { bot, slack, state } = makeBot();
  bot.claimer.arm();
  const ts = nowTs();
  for (const e of [
    { type: "message", channel: "CLEADS", ts, user: "UPERSON", text: "New lead alert" },
    lead({ bot_profile: { name: "Zapier" } }),
    lead({ thread_ts: "1.000001" }),
    lead({ channel: "COTHER" }),
    lead({ subtype: "message_changed" }),
    lead({ text: "New lead alert: Jase Chijioke" }),
  ]) assert.equal(await bot.claimer.claim(e), false);
  assert.equal(claimReplies(slack).length, 0);
  assert.equal(state.armed, true);
});

test("a failed claim says so and stays ON with the same start time, so the backup check retries it", async () => {
  let fail = true;
  const { bot, slack, state } = makeBot({
    rand: () => 0.1,
    handlers: {
      "chat.postMessage": (b) => {
        if (b.text === "t" && fail) throw new Error("chat.postMessage: ratelimited");
        return { ok: true, ts: nowTs() };
      },
    },
  });
  bot.claimer.arm();
  const armedAt = state.armedAt;
  const l = lead();
  assert.equal(await bot.claimer.claim(l), false);
  assert.equal(slack.calls.filter((c) => c.body.text === "t").length, 3); // first try + 2 retries
  assert.equal(state.armed, true);
  assert.equal(state.armedAt, armedAt);
  assert.ok(slack.posts("xoxb-1").some((c) => /Claim failed/.test(c.body.text || "")));

  fail = false;
  slack.calls.length = 0;
  const history = makeHistory([l]);
  slack.call = wrap(slack.call, history);
  await bot.claimer.catchUp();
  assert.equal(slack.calls.filter((c) => c.body.text === "t").length, 1);
  assert.equal(state.armed, false);
});

test("if Slack times out but the reply actually landed, it counts as claimed", async () => {
  const { bot, slack, state } = makeBot({
    rand: () => 0.1,
    handlers: {
      "chat.postMessage": (b) => {
        if (b.text === "t") throw new Error("This operation was aborted due to timeout");
        return { ok: true, ts: nowTs() };
      },
      "conversations.replies": (b) => ({ ok: true, messages: [{ ts: b.ts }, { ts: "9.9", user: "UME" }] }),
    },
  });
  bot.claimer.arm();
  assert.equal(await bot.claimer.claim(lead()), true);
  assert.equal(state.armed, false);
  assert.ok(slack.posts("xoxb-1").some((c) => /Claimed 1 lead.*slow to confirm/.test(c.body.text || "")));
});

test("timed mode waits until the reply is due, and skips a lead you already answered by hand", async () => {
  const { bot, slack, sleeps, state } = makeBot({
    env: { REPLY_DELAY_MS: "800" },
    rand: () => 0.1,
    handlers: { "conversations.replies": (b) => ({ ok: true, messages: [{ ts: b.ts }, { ts: "9.9", user: "UME" }] }) },
  });
  bot.claimer.arm();
  assert.equal(await bot.claimer.claim(lead()), false);
  assert.ok(sleeps[0] > 700 && sleeps[0] <= 800, `waited ${sleeps[0]}ms`);
  assert.equal(claimReplies(slack).length, 0);
  assert.equal(state.armed, false);
  assert.ok(slack.posts("xoxb-1").some((c) => /already replied/.test(c.body.text || "")));
});

test("the backup check claims a lead the live connection missed", async () => {
  const { bot, slack, state } = makeBot({ rand: () => 0.1 });
  bot.claimer.arm();
  const l = lead();
  slack.call = wrap(slack.call, makeHistory([l]));
  await bot.claimer.catchUp();
  const replies = claimReplies(slack);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.thread_ts, l.ts);
  assert.equal(state.armed, false);
});

function makeHistory(msgs) {
  return (method, body) => (method === "conversations.history" && body.oldest ? { ok: true, messages: msgs.map(({ channel, type, ...m }) => m).reverse() } : null);
}
function wrap(call, override) {
  return async (method, token, body) => override(method, body) || call(method, token, body);
}
