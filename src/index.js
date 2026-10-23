// Zero-dependency Slack lead claimer: Socket Mode over WebSocket + Web API over fetch.
// Press On in Bot Control -> claims the NEXT lead in watched channels with a lowercase "t" (as you),
// replies the instant the lead arrives (INSTANT mode), then turns itself off.
const fs = require("node:fs");
const path = require("node:path");

// ---------- settings (trimmed; swapped tokens are fixed automatically) ----------
const env = (k) => (process.env[k] || "").trim().replace(/^["']|["']$/g, "");
let SLACK_APP_TOKEN = env("SLACK_APP_TOKEN");
let SLACK_BOT_TOKEN = env("SLACK_BOT_TOKEN");
let SLACK_USER_TOKEN = env("SLACK_USER_TOKEN");
const CLAIM_USER_ID = env("CLAIM_USER_ID");
const CONTROL_CHANNEL = env("CONTROL_CHANNEL");
const CLAIM_CHANNELS = env("CLAIM_CHANNELS");
const CLAIM_MATCH = env("CLAIM_MATCH");
const LEAD_BOT_NAME = (env("LEAD_BOT_NAME") || "AIBot").toLowerCase(); // the app that posts your lead alerts

if (SLACK_BOT_TOKEN.startsWith("xoxp-") && SLACK_USER_TOKEN.startsWith("xoxb-")) {
  [SLACK_BOT_TOKEN, SLACK_USER_TOKEN] = [SLACK_USER_TOKEN, SLACK_BOT_TOKEN]; // you pasted them the wrong way round
}
const problems = [];
if (!SLACK_APP_TOKEN.startsWith("xapp-")) problems.push("SLACK_APP_TOKEN must start with xapp-");
if (!SLACK_BOT_TOKEN.startsWith("xoxb-")) problems.push("SLACK_BOT_TOKEN must start with xoxb-");
if (!SLACK_USER_TOKEN.startsWith("xoxp-")) problems.push("SLACK_USER_TOKEN must start with xoxp-");
if (!/^U[A-Z0-9]+$/.test(CLAIM_USER_ID)) problems.push("CLAIM_USER_ID must look like U0123ABCDEF");
if (!/^[CG][A-Z0-9]+$/.test(CONTROL_CHANNEL)) problems.push("CONTROL_CHANNEL must look like C0123ABCDEF");
if (problems.length) throw new Error("Fix your .env file:\n - " + problems.join("\n - "));

const CLAIM_TEXT = "t"; // the reply is always exactly "t"
const INSTANT = true; // true = reply the moment the lead arrives (no delay, no checks in the way); false = timed reply (below)
const MIN_MS = 700, MAX_MS = 900, TARGET_MS = 780; // timed mode: the first reply lands this long after the lead
const MAX_LEAD_AGE_MS = 60000; // only leads posted in the last minute are claimed
const matcher = CLAIM_MATCH ? new RegExp(CLAIM_MATCH, "i") : null;
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- never die: log and carry on ----------
process.on("uncaughtException", (e) => log("Unexpected error (kept running):", e && e.message));
process.on("unhandledRejection", (e) => log("Unexpected rejection (kept running):", e && e.message));

// Background jobs are registered here and started only inside the real bot process.
const timerJobs = [];
function every(fn, ms) { timerJobs.push([fn, ms]); }
function startTimers() { for (const [fn, ms] of timerJobs) setInterval(fn, ms); }

// ---------- state (written atomically so a crash can't corrupt it) ----------
const STATE_FILE = path.join(__dirname, "..", "state.json");
const NEVER_REPLY_NAMES = ["Jase Chijioke"]; // built in: never reply to this person, or to alerts naming them
// Optional second channel (e.g. optin-2): claiming there turns off only that channel; claiming anywhere else turns off both.
const state = { armed: false, armedAt: "0", second: null, armedSecond: false, armedSecondAt: "0", leadBotId: null, ignoredUsers: [], ignoredNames: [], channels: CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean) };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
} catch {}
function save() {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log("Could not save state:", e.message);
  }
}
function arm() {
  const now = ((Date.now() + clockOffset) / 1000 - 1).toFixed(6); // Slack's clock, 1s margin
  if (!state.armed) state.armedAt = now;
  if (state.second && !state.armedSecond) state.armedSecondAt = now;
  state.armed = true;
  state.armedSecond = !!state.second;
  save();
}
function disarm() {
  state.armed = false;
  state.armedSecond = false;
  save();
}
const isSecond = (channel) => !!state.second && channel === state.second;
const armedFor = (channel) => (isSecond(channel) ? state.armedSecond : state.armed);
// What is armed right now, in words, for Bot Control.
function armedText(bold = "") {
  if (!state.armed) return `🔴 ${bold}OFF${bold}`;
  if (!state.second) return `🟢 ${bold}ON${bold}: claiming the next lead`;
  const others = state.channels.filter((c) => c !== state.second).map((c) => `<#${c}>`).join(", ") || "your other channels";
  return `🟢 ${bold}ON${bold}: ${others} ON · <#${state.second}> ${state.armedSecond ? "ON" : "OFF (press On to re-arm it)"}`;
}
const afterClaim = () => (state.armed ? `Still ON. ${armedText()}` : "Now OFF.");

// ---------- Slack API ----------
let clockOffset = 0; // Slack's clock minus this PC's clock, in ms
let minRtt = Infinity;
async function slack(method, token, body, timeoutMs = 8000) {
  const t0 = Date.now();
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${method}: bad_response_${res.status}`);
  }
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  if (method === "chat.postMessage" && json.ts) {
    const t1 = Date.now();
    const rtt = t1 - t0;
    const sample = Number(json.ts) * 1000 - (t0 + t1) / 2; // Slack stamped it about mid-flight
    minRtt = Math.min(minRtt * 1.02, rtt);
    const w = clockOffset === 0 ? 1 : rtt <= minRtt * 1.3 ? 0.5 : 0.15; // trust quick round trips most
    clockOffset = clockOffset * (1 - w) + sample * w;
  }
  return json;
}

// ---------- fast lane: private, always-warm connections used ONLY for the "t" ----------
// Nothing else (backup checks, Bot Control messages) ever uses these, so the claim never queues behind
// another request or waits for a new secure connection to be set up.
const https = require("node:https");
const fastAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 4, maxFreeSockets: 4, scheduling: "lifo" });
const FAST_WARM = 2; // connections kept open and ready
function fastSlack(method, token, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = https.request({
      host: "slack.com", path: `/api/${method}`, method: "POST", agent: fastAgent, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(raw); } catch { return reject(new Error(`${method}: bad_response_${res.statusCode}`)); }
        if (!json.ok) return reject(new Error(`${method}: ${json.error}`));
        resolve(json);
      });
    });
    req.setNoDelay(true);
    req.on("timeout", () => req.destroy(new Error(`${method}: timed out`)));
    req.on("error", reject);
    req.end(data);
  });
}
// Keep FAST_WARM connections open by sending a tiny request down each one.
function warmFastLane() {
  for (let i = 0; i < FAST_WARM; i++) fastSlack("api.test", SLACK_USER_TOKEN, {}, 4000).catch(() => {});
}
const config = { forceCount: null, post: (body) => fastSlack("chat.postMessage", SLACK_USER_TOKEN, body) }; // tests replace post

// Post and delete a tiny message in Bot Control so we learn Slack's clock precisely.
async function calibrate() {
  try {
    const r = await slack("chat.postMessage", SLACK_BOT_TOKEN, { channel: CONTROL_CHANNEL, text: "·" }, 4000);
    slack("chat.delete", SLACK_BOT_TOKEN, { channel: CONTROL_CHANNEL, ts: r.ts }, 4000).catch(() => {});
  } catch (e) {
    log("calibrate:", e.message);
  }
}

const say = (text, thread_ts) =>
  slack("chat.postMessage", SLACK_BOT_TOKEN, { channel: CONTROL_CHANNEL, text, thread_ts }).catch((e) => log("say failed:", e.message));

// Tell you in Bot Control when something is wrong, but not more than once per 10 minutes per problem.
const alerted = new Map();
function alertOnce(key, text) {
  if (Date.now() - (alerted.get(key) || 0) < 600000) return;
  alerted.set(key, Date.now());
  say(text);
}

// A lead is ONLY a "New Lead Alert" message posted by the AIBot app. Messages from people, from any other app,
// and any other AIBot message are never claimed. Once the first real AIBot lead is claimed, the bot remembers
// AIBot's app ID and from then on accepts only that exact app.
function isLeadAlert(e) {
  if (!e.bot_id) return false; // posted by a person, not an app
  if (!/new lead alert/i.test(fullText(e))) return false; // must be a lead alert
  if (state.leadBotId) return e.bot_id === state.leadBotId;
  const names = [e.bot_profile && e.bot_profile.name, e.username].filter(Boolean).map((n) => String(n).toLowerCase());
  return !names.length || names.includes(LEAD_BOT_NAME); // a name is shown: it must be AIBot
}

// True if this message is from (or about) someone on the never-reply list.
function isIgnored(e) {
  if (e.user && state.ignoredUsers.includes(e.user)) return true;
  const hay = [fullText(e), e.username, e.bot_profile && e.bot_profile.name, e.user_profile && e.user_profile.real_name, e.user_profile && e.user_profile.display_name]
    .filter(Boolean).join("\n").toLowerCase();
  return [...NEVER_REPLY_NAMES, ...state.ignoredNames].some((n) => n && hay.includes(String(n).toLowerCase()));
}

function fullText(e) {
  const parts = [e.text, ...(e.attachments || []).flatMap((a) => [a.pretext, a.title, a.text, a.fallback])];
  const walk = (b) => { // text inside Slack "blocks" (some apps put the message only there)
    if (!b || typeof b !== "object") return;
    if (Array.isArray(b)) return b.forEach(walk);
    if (typeof b.text === "string") parts.push(b.text);
    for (const k of ["text", "fields", "elements", "blocks"]) if (b[k] && typeof b[k] === "object") walk(b[k]);
  };
  walk(e.blocks);
  (e.attachments || []).forEach((a) => walk(a.blocks));
  return parts.filter(Boolean).join("\n");
}

const HINTS = {
  channel_not_found: "your account can't see that channel (or the app needs Reinstall to Workspace after the permissions update)",
  missing_scope: "the app is missing a permission: save the new App Manifest, then Reinstall to Workspace",
  token_revoked: "that key was revoked: reinstall the app and copy fresh keys",
  account_inactive: "that key belongs to an inactive account: reinstall the app and copy fresh keys",
  invalid_auth: "that key is wrong: copy it again from Slack",
  not_in_channel: "the account/bot isn't in that channel",
};
const hint = (msg) => {
  if (/aborted due to timeout|timed out|fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(msg)) return "Slack or your internet was too slow to answer just then. This is usually temporary";
  const code = (msg.split(": ")[1] || "").trim();
  return HINTS[code] ? `${msg} (${HINTS[code]})` : msg;
};

// Measure the real round trip from wherever this bot runs to Slack over the same fast lane the "t" uses (lower = faster).
async function pingSlack() {
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    try {
      await fastSlack("auth.test", SLACK_USER_TOKEN, {}, 4000);
      times.push(Date.now() - t0);
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  times.shift(); // the first call includes setting up the connection
  const where = process.env.RENDER ? "the Render server" : `this computer (${require("node:os").hostname()})`;
  if (!times.length) return say(`⚠️ Could not measure the speed to Slack from ${where}.`);
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  await say(`🏓 Round trip to Slack from ${where}: best ${Math.min(...times)}ms, average ${avg}ms, worst ${Math.max(...times)}ms. Lower is faster.`);
}

// Check every key and every watched channel; report in Bot Control.
async function selfCheck() {
  const lines = [];
  try {
    const a = await slack("auth.test", SLACK_USER_TOKEN);
    lines.push(`✅ Your account key works (${a.user})`);
    if (a.user_id !== CLAIM_USER_ID) lines.push(`⚠️ CLAIM_USER_ID is not the account that owns your xoxp key (it is ${a.user_id})`);
  } catch (e) {
    lines.push(`❌ Your account key (xoxp): ${hint(e.message)}`);
  }
  try {
    await slack("auth.test", SLACK_BOT_TOKEN);
    lines.push("✅ Bot key works");
  } catch (e) {
    lines.push(`❌ Bot key (xoxb): ${hint(e.message)}`);
  }
  for (const channel of state.channels) {
    try {
      await slack("conversations.history", SLACK_USER_TOKEN, { channel, limit: 1 });
      lines.push(`✅ Can read <#${channel}>`);
    } catch (e) {
      lines.push(`❌ Can't read <#${channel}>: ${hint(e.message)}`);
    }
  }
  if (!state.channels.length) lines.push("⚠️ Not watching any channel yet. Type: watch #your-leads-channel");
  await say(lines.join("\n"));
}

// ---------- claiming ----------
// How many "t" replies to send: always exactly one.
function pickReplyCount() {
  return config.forceCount || 1;
}
// Follow-up "t"s after the first, a fraction of a second apart. Never affects the claim itself.
async function sendFollowUps(event, count) {
  for (let i = 1; i < count; i++) {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 550));
    try {
      await slack("chat.postMessage", SLACK_USER_TOKEN, { channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT }, 4000);
    } catch (e) {
      log("follow-up t failed:", e.message);
      return;
    }
  }
}

// One immediate attempt, then up to 2 quick retries on transient errors.
async function postWithRetry(event) {
  for (let i = 0; ; i++) {
    try {
      const sent = await config.post({ channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT });
      return { ...sent, tries: i + 1 };
    } catch (err) {
      if (i >= 2 || /not_in_channel|channel_not_found|invalid_auth|token_revoked|account_inactive|missing_scope|is_archived/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

async function claim(event, heardAt = Date.now()) {
  if (!armedFor(event.channel) || !state.channels.includes(event.channel)) return;
  if (event.subtype && !["bot_message", "file_share"].includes(event.subtype)) return; // edits, joins, etc.
  if (event.user === CLAIM_USER_ID) return;
  if (isIgnored(event)) return; // never reply to people on the list (the bot stays ON for the next lead)
  if (!isLeadAlert(event)) return; // only AIBot lead alerts, never normal messages
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (matcher && !matcher.test(fullText(event))) return;
  if ((Date.now() + clockOffset) - Number(event.ts) * 1000 > MAX_LEAD_AGE_MS) return; // stale (e.g. found by catch-up after downtime): never claim
  // Synchronous: guarantees only ONE lead per channel group is claimed.
  // A second-channel lead turns off only the second channel; any other lead turns off both.
  const second = isSecond(event.channel);
  const wasSecondArmed = state.armedSecond;
  if (second) state.armedSecond = false;
  else { state.armed = false; state.armedSecond = false; }
  const leadMs = Number(event.ts) * 1000;

  // Instant mode: fire the reply right now. Nothing is awaited before it.
  // Timed mode (INSTANT = false): wait so the reply lands TARGET_MS after the lead, by Slack's clock.
  let alreadyClaimed = Promise.resolve(false);
  if (!INSTANT) {
    alreadyClaimed = slack("conversations.replies", SLACK_USER_TOKEN, { channel: event.channel, ts: event.ts, limit: 20 }, 3000)
      .then((r) => (r.messages || []).some((m) => m.ts !== event.ts && m.user === CLAIM_USER_ID))
      .catch(() => false);
    const wait = Math.max(0, Math.min(1700, leadMs + TARGET_MS + corr - (Date.now() + clockOffset)));
    await new Promise((r) => setTimeout(r, wait));
  }
  const firstReply = INSTANT ? postWithRetry(event) : null; // already in flight
  save(); // the disk write happens while the reply is on its way

  try {
    if (!INSTANT && (await alreadyClaimed)) {
      await say(`ℹ️ Skipped: you already replied to that lead in <#${event.channel}>. ${afterClaim()}`);
    } else {
      const sent = await (firstReply || postWithRetry(event));
      const actual = Math.round(Number(sent.ts) * 1000 - leadMs); // exact: Slack's own timestamps
      if (!INSTANT && Number.isFinite(actual) && sent.tries === 1 && Math.abs(actual - TARGET_MS) < 300) { // learn only from clean claims
        const step = Math.max(-100, Math.min(100, (actual - TARGET_MS) * 0.3));
        corr = Math.max(-600, Math.min(300, corr - step));
      }
      if (!state.leadBotId && event.bot_id) { state.leadBotId = event.bot_id; save(); } // lock onto AIBot
      const count = pickReplyCount();
      sendFollowUps(event, count).catch((e) => log("follow-ups error:", e.message)); // runs in the background
      const ok = INSTANT || (actual >= MIN_MS && actual <= MAX_MS);
      const heard = Math.max(0, Math.round(heardAt + clockOffset - leadMs)); // how late Slack told us about the lead
      log(`Claimed ${event.channel} ${event.ts}: Slack told us ${heard}ms after the lead, reply landed ${actual}ms after it (${count} t's)`);
      await say(`${ok ? "⚡" : "⚠️"} Claimed 1 lead in <#${event.channel}>: replied "${CLAIM_TEXT}" ${count > 1 ? `x${count} ` : ""}(landed ${actual}ms after the lead; Slack told us about it after ~${heard}ms, so our part took ~${Math.max(0, actual - heard)}ms)${ok ? "" : " (outside the 700-900ms window)"}. ${afterClaim()}`);
    }
  } catch (err) {
    if (second) state.armedSecond = true; // failed: stay armed so the next lead is still claimed
    else { state.armed = true; state.armedSecond = wasSecondArmed; }
    save();
    log("Claim failed:", err.message);
    await say(`⚠️ Claim failed in <#${event.channel}>: ${hint(err.message)}. Still ON.`);
  }
  panel();
}
let corr = -120; // ms; learned shift so the reply LANDS at TARGET_MS

// ---------- Bot Control commands (only from you) ----------
const seenControl = new Set();
function control(event) {
  if (event.user !== CLAIM_USER_ID || event.subtype || event.bot_id) return;
  if (seenControl.has(event.ts)) return; // same message delivered as bot event and user event
  seenControl.add(event.ts);
  if (seenControl.size > 500) seenControl.delete(seenControl.values().next().value);
  const text = (event.text || "").trim();
  const ids = [...text.matchAll(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const cmd = text.split(/\s+/)[0].toLowerCase();
  let reply;
  let after;
  if (cmd === "watch" && ids.length) {
    for (const id of ids) if (!state.channels.includes(id)) state.channels.push(id);
    save();
    reply = `✅ Watching ${ids.map((i) => `<#${i}>`).join(", ")}`;
    after = selfCheck;
  } else if (cmd === "unwatch" && ids.length) {
    state.channels = state.channels.filter((c) => !ids.includes(c));
    if (ids.includes(state.second)) { state.second = null; state.armedSecond = false; }
    save();
    reply = `🛑 Stopped watching ${ids.map((i) => `<#${i}>`).join(", ")}`;
  } else if (cmd === "second" && ids.length) {
    state.second = ids[0];
    if (!state.channels.includes(state.second)) state.channels.push(state.second);
    state.armedSecond = state.armed; // joins in straight away if the bot is already ON
    state.armedSecondAt = ((Date.now() + clockOffset) / 1000 - 1).toFixed(6);
    save();
    reply = `✅ <#${state.second}> is now the second channel. On claims one lead in it and stays ON for your other channels. A lead claimed anywhere else turns both off.`;
    after = selfCheck;
  } else if (cmd === "second" && /\boff\b/i.test(text)) {
    const was = state.second;
    state.second = null; state.armedSecond = false; save();
    reply = was ? `✅ <#${was}> is a normal watched channel again (one lead in any channel turns the bot OFF). Type \`unwatch <#${was}>\` to stop watching it.` : "There is no second channel set.";
  } else if (cmd === "on") {
    arm();
    warmFastLane();
    reply = state.second ? armedText() : "🟢 ON: will claim the next lead, then turn off";
    after = () => warnIfNotReady("Bot is ON");
  } else if (cmd === "off") {
    disarm(); reply = "🔴 OFF";
  } else if (cmd === "ignore" || cmd === "unignore") {
    const users = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
    const name = text.replace(/^\S+\s*/, "").replace(/<[@#][^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (!users.length && !name) {
      reply = `Type: ${cmd} @person   (or: ${cmd} Their Name)`;
    } else if (cmd === "ignore") {
      for (const u of users) if (!state.ignoredUsers.includes(u)) state.ignoredUsers.push(u);
      if (name && !state.ignoredNames.some((n) => n.toLowerCase() === name.toLowerCase())) state.ignoredNames.push(name);
      save();
      reply = `🚫 I will never reply to: ${[...users.map((u) => `<@${u}>`), name].filter(Boolean).join(", ")}`;
    } else {
      state.ignoredUsers = state.ignoredUsers.filter((u) => !users.includes(u));
      state.ignoredNames = state.ignoredNames.filter((n) => n.toLowerCase() !== name.toLowerCase());
      save();
      reply = `✅ Removed from the never-reply list: ${[...users.map((u) => `<@${u}>`), name].filter(Boolean).join(", ")}`;
    }
  } else if (cmd === "forgetbot") {
    state.leadBotId = null; save(); reply = "🔓 Forgot AIBot's app ID. It will learn it again from the next claimed lead.";
  } else if (cmd === "ignored") {
    reply = `🚫 Never replying to: ${[...NEVER_REPLY_NAMES, ...state.ignoredNames, ...state.ignoredUsers.map((u) => `<@${u}>`)].join(", ")}`;
  } else if (cmd === "check") {
    after = selfCheck;
  } else if (cmd === "ping") {
    after = pingSlack;
  } else if (cmd === "status") {
    reply = `${armedText()} · reply "${CLAIM_TEXT}" ${INSTANT ? "INSTANT" : `at ${MIN_MS}-${MAX_MS}ms`} · watching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet"} · replies once, only to AIBot "New Lead Alert" messages${state.leadBotId ? " (locked to its app ID)" : ""}\nCommands: on, off, status, check, ping, watch #channel, unwatch #channel, second #channel, second off, ignore @person, unignore @person, ignored`;
  } else {
    panel();
    return;
  }
  if (reply) say(reply, event.ts);
  panel();
  if (after) after().catch((e) => log("check failed:", e.message));
}

function panel() {
  return slack("chat.postMessage", SLACK_BOT_TOKEN, {
    channel: CONTROL_CHANNEL,
    text: armedText(),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${armedText("*")}\nWatching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet (type `watch #your-leads-channel`)"}` } },
      { type: "actions", elements: [
        { type: "button", action_id: "on", text: { type: "plain_text", text: "On" }, style: "primary" },
        { type: "button", action_id: "off", text: { type: "plain_text", text: "Off" }, style: "danger" },
      ] },
    ],
  }).catch((e) => log("panel failed:", e.message));
}

// ---------- safety net: while ON, also read the channels directly ----------
let polling = false;
let pollPausedUntil = 0;
let pollFails = 0; // consecutive failed backup checks
async function catchUp() {
  if (!state.armed || polling || Date.now() < pollPausedUntil) return;
  polling = true;
  try {
    for (const channel of state.channels) {
      if (!state.armed) break;
      if (!armedFor(channel)) continue;
      const oldest = isSecond(channel) ? state.armedSecondAt : state.armedAt;
      const { messages = [] } = await slack("conversations.history", SLACK_USER_TOKEN, { channel, oldest, limit: 50 }, 7000);
      for (const m of messages.reverse()) await claim({ ...m, channel });
    }
    pollFails = 0;
  } catch (err) {
    pollFails++;
    pollPausedUntil = Date.now() + (pollFails > 1 ? 10000 : 2000); // don't hammer Slack while it's failing
    log("catchUp:", err.message);
    // One slow answer is normal (the main connection still works). Only warn if it keeps failing.
    if (pollFails >= 3) alertOnce("poll:" + hint(err.message), `⚠️ Backup check has failed ${pollFails} times in a row: ${hint(err.message)}. The main connection may still be fine. Type \`check\` for details.`);
  } finally {
    polling = false;
  }
}
every(() => catchUp().catch(() => {}), 1200);
every(() => { if (state.armed) calibrate(); }, 180000); // keep the clock fresh while ON
every(() => { if (state.armed) warmFastLane(); }, 2500); // while ON: keep the fast lane warm so the reply never waits for a new handshake

// While ON, re-check every 5 minutes that keys and channels still work, so a problem is reported BEFORE a lead arrives.
async function readiness() {
  const bad = [];
  try { await slack("auth.test", SLACK_USER_TOKEN); } catch (e) { bad.push(`your account key: ${hint(e.message)}`); }
  try { await slack("auth.test", SLACK_BOT_TOKEN); } catch (e) { bad.push(`bot key: ${hint(e.message)}`); }
  for (const channel of state.channels) {
    try { await slack("conversations.history", SLACK_USER_TOKEN, { channel, limit: 1 }); } catch (e) { bad.push(`<#${channel}>: ${hint(e.message)}`); }
  }
  if (!state.channels.length) bad.push("not watching any channel (type: watch #your-leads-channel)");
  return bad;
}
async function warnIfNotReady(prefix) {
  const bad = await readiness();
  if (bad.length) await say(`⚠️ ${prefix} but NOT READY, a lead would be missed:\n• ${bad.join("\n• ")}\nType \`check\` for details.`);
  return bad.length === 0;
}
every(() => { if (state.armed) warnIfNotReady("Bot is ON").catch(() => {}); }, 300000);

// ---------- connection: reconnects forever, with a watchdog ----------
let ws = null;
let gen = 0;
let backoff = 1000;
let lastActivity = Date.now();
let firstConnect = true;
let reconnectTimer = null;

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function onMessage(msg, heardAt) {
  lastActivity = Date.now();
  if (msg.type === "events_api" && msg.payload.event?.type === "message") {
    const e = msg.payload.event;
    if (e.channel === CONTROL_CHANNEL) control(e);
    else claim(e, heardAt).catch((err) => log("claim error:", err.message));
  }
  if (msg.type === "interactive" && msg.payload.user?.id === CLAIM_USER_ID) {
    const a = msg.payload.actions?.[0]?.action_id;
    if (a === "on" || a === "off") {
      if (a === "on") { arm(); warmFastLane(); }
      else disarm();
      panel();
      if (a === "on") warnIfNotReady("Bot is ON").catch((e) => log("readiness failed:", e.message));
    }
  }
}

async function connect() {
  const my = ++gen;
  try {
    const { url } = await slack("apps.connections.open", SLACK_APP_TOKEN);
    if (my !== gen) return;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = async () => {
      backoff = 1000;
      lastActivity = Date.now();
      log("Connected.");
      await calibrate();
      if (firstConnect) {
        firstConnect = false;
        await say("👋 Lead claimer is online.");
        panel();
        selfCheck().catch((e) => log("check failed:", e.message));
      }
      catchUp().catch(() => {}); // anything that landed while we were offline
    };
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      const heardAt = Date.now();
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "disconnect") return sock.close();
        onMessage(msg, heardAt); // the "t" is already on its way before we even acknowledge the event
        if (msg.envelope_id) sock.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      } catch (e) {
        log("message error:", e.message);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      log("Disconnected, reconnecting...");
      scheduleReconnect();
    };
    sock.onerror = (e) => log("WebSocket error:", (e && e.message) || "unknown");
  } catch (err) {
    log("Connect failed:", err.message);
    scheduleReconnect();
  }
}

// Watchdog: if nothing has been heard for 3 minutes the connection may be dead without saying so; start a fresh one.
every(() => {
  if (!ws || Date.now() - lastActivity < 180000) return;
  log("No activity for 3 minutes, reconnecting...");
  const old = ws;
  ws = null;
  lastActivity = Date.now();
  try { old.close(); } catch {}
  connect();
}, 30000);

// Supervisor: runs the bot as a child process and restarts it within 2 seconds if it ever exits for any reason.
function supervise() {
  const { spawn } = require("node:child_process");
  let stopping = false;
  let child = null;
  const run = () => {
    child = spawn(process.execPath, [__filename], { stdio: "inherit", env: { ...process.env, BOT_CHILD: "1" } });
    child.on("exit", (code, signal) => {
      if (stopping) process.exit(0);
      log(`Bot stopped (${signal || "code " + code}). Restarting in 2 seconds...`);
      setTimeout(run, 2000);
    });
  };
  // On a Mac: stop it napping or sleeping while the bot runs (a napping Mac reacts slowly). The screen can still turn off.
  if (process.platform === "darwin") {
    try { spawn("caffeinate", ["-i", "-m", "-s", "-w", String(process.pid)], { stdio: "ignore" }).on("error", () => {}); } catch {}
  }
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { stopping = true; try { child && child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
  }
  run();
}

if (require.main === module) {
  if (process.env.BOT_CHILD) {
    startTimers();
    warmFastLane();
    connect();
  } else {
    supervise();
  }
}
module.exports = { claim, control, state, arm, slack, calibrate, pickReplyCount, config }; // for tests
