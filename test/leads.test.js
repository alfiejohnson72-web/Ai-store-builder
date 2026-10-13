const test = require("node:test");
const assert = require("node:assert/strict");
const { isLeadAlert, isIgnored, pickReplyCount } = require("../src/leads");

const opts = { leadBotId: null, leadBotName: "aibot" };

test("only the lead app's posts are leads", () => {
  assert.equal(isLeadAlert({ user: "U1", text: "New lead alert" }, opts), false); // a person
  assert.equal(isLeadAlert({ bot_id: "B1", bot_profile: { name: "AIBot" } }, opts), true);
  assert.equal(isLeadAlert({ bot_id: "B2", bot_profile: { name: "Other App" }, text: "New lead alert" }, opts), false);
  assert.equal(isLeadAlert({ bot_id: "B3", text: "NEW LEAD ALERT: Sam" }, opts), true); // no name shown: text fallback
  assert.equal(isLeadAlert({ bot_id: "B3", text: "hello" }, opts), false);
});

test("once locked, only that exact app counts", () => {
  const locked = { ...opts, leadBotId: "B1" };
  assert.equal(isLeadAlert({ bot_id: "B1" }, locked), true);
  assert.equal(isLeadAlert({ bot_id: "B9", bot_profile: { name: "AIBot" } }, locked), false);
});

test("never-reply list matches built-in names, saved names and users, anywhere in the alert", () => {
  const lists = { ignoredUsers: ["UBAD"], ignoredNames: ["Pat Doe"] };
  assert.equal(isIgnored({ attachments: [{ title: "Lead from jase chijioke" }] }, lists), true);
  assert.equal(isIgnored({ text: "Lead: PAT DOE" }, lists), true);
  assert.equal(isIgnored({ user: "UBAD" }, lists), true);
  assert.equal(isIgnored({ text: "Lead: Sam" }, lists), false);
});

test("reply count: 20% one, the rest two to four", () => {
  assert.equal(pickReplyCount(() => 0.1), 1);
  assert.equal(pickReplyCount(() => 0.3), 2);
  assert.equal(pickReplyCount(() => 0.7), 3);
  assert.equal(pickReplyCount(() => 0.95), 4);
});
