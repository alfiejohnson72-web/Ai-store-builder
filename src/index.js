// Zero-dependency Slack lead claimer: Socket Mode over WebSocket + Web API over fetch.
// Press On in Bot Control -> claims the NEXT lead in watched channels with a lowercase "t" (as you),
// lands the reply ~1000-1200ms after the lead, then turns itself off.
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
const MIN_MS = 1000, MAX_MS = 1200, TARGET_MS = 1100; // reply must land this long after the lead
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
const state = { armed: false, armedAt: "0", channels: CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean) };
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
  if (!state.armed) state.armedAt = ((Date.now() + clockOffset) / 1000 - 1).toFixed(6); // Slack's clock, 1s margin
  state.armed = true;
  save();
}

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

// A lead is ONLY a message posted by the lead-alert app (AIBot / "New Lead Alert"). Messages from people are never claimed.
function isLeadAlert(e) {
  if (!e.bot_id) return false; // posted by a person, not an app
  const names = [e.bot_profile && e.bot_profile.name, e.username].filter(Boolean).map((n) => String(n).toLowerCase());
  return names.includes(LEAD_BOT_NAME) || /new lead alert/i.test(fullText(e));
}

function fullText(e) {
  const parts = [e.text, ...(e.attachments || []).flatMap((a) => [a.pretext, a.title, a.text, a.fallback])];
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
// How many "t" replies to send: 20% just one, 80% two to four (max 4), like quick manual spamming.
const config = { forceCount: null }; // tests only
function pickReplyCount(rand = Math.random) {
  if (config.forceCount) return config.forceCount;
  const r = rand();
  if (r < 0.2) return 1;
  if (r < 0.6) return 2; // 40%
  if (r < 0.88) return 3; // 28%
  return 4; // 12%
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
      const sent = await slack("chat.postMessage", SLACK_USER_TOKEN, { channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT }, 4000);
      return { ...sent, tries: i + 1 };
    } catch (err) {
      if (i >= 2 || /not_in_channel|channel_not_found|invalid_auth|token_revoked|account_inactive|missing_scope|is_archived/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

async function claim(event) {
  if (!state.armed || !state.channels.includes(event.channel)) return;
  if (event.subtype && !["bot_message", "file_share"].includes(event.subtype)) return; // edits, joins, etc.
  if (event.user === CLAIM_USER_ID) return;
  if (!isLeadAlert(event)) return; // only AIBot lead alerts, never normal messages
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (matcher && !matcher.test(fullText(event))) return;
  state.armed = false; // synchronous: guarantees only ONE lead is claimed
  save();

  // While we wait for the timing window, check nobody (e.g. a second copy of this bot) already replied as you.
  const alreadyClaimed = slack("conversations.replies", SLACK_USER_TOKEN, { channel: event.channel, ts: event.ts, limit: 20 }, 3000)
    .then((r) => (r.messages || []).some((m) => m.ts !== event.ts && m.user === CLAIM_USER_ID))
    .catch(() => false);

  // Wait until the reply will LAND TARGET_MS after the lead, by Slack's clock (bounded, so a bad clock can't stall us).
  const leadMs = Number(event.ts) * 1000;
  const wait = Math.max(0, Math.min(1700, leadMs + TARGET_MS + corr - (Date.now() + clockOffset)));
  await new Promise((r) => setTimeout(r, wait));

  try {
    if (await alreadyClaimed) {
      await say(`ℹ️ Skipped: you already replied to that lead in <#${event.channel}>. Now OFF.`);
    } else {
      const sent = await postWithRetry(event);
      const actual = Math.round(Number(sent.ts) * 1000 - leadMs); // exact: Slack's own timestamps
      if (Number.isFinite(actual) && sent.tries === 1 && Math.abs(actual - TARGET_MS) < 300) { // learn only from clean, first-try, non-spike claims
        const step = Math.max(-100, Math.min(100, (actual - TARGET_MS) * 0.3));
        corr = Math.max(-600, Math.min(300, corr - step));
      }
      const ok = actual >= MIN_MS && actual <= MAX_MS;
      const count = pickReplyCount();
      sendFollowUps(event, count).catch((e) => log("follow-ups error:", e.message)); // runs in the background
      log(`Claimed ${event.channel} ${event.ts}: reply landed ${actual}ms after the lead (${count} t's)`);
      await say(`${ok ? "✅" : "⚠️"} Claimed 1 lead in <#${event.channel}>: replied "${CLAIM_TEXT}" ${count > 1 ? `x${count} ` : ""}(first one ${actual}ms after it was posted)${ok ? "" : " (outside the 1000-1200ms window)"}. Now OFF.`);
    }
  } catch (err) {
    state.armed = true; // failed: stay armed so the next lead is still claimed
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
    save();
    reply = `🛑 Stopped watching ${ids.map((i) => `<#${i}>`).join(", ")}`;
  } else if (cmd === "on") {
    arm();
    reply = "🟢 ON: will claim the next lead, then turn off";
    after = () => warnIfNotReady("Bot is ON");
  } else if (cmd === "off") {
    state.armed = false; save(); reply = "🔴 OFF";
  } else if (cmd === "check") {
    after = selfCheck;
  } else if (cmd === "status") {
    reply = `${state.armed ? "🟢 ON" : "🔴 OFF"} · reply "${CLAIM_TEXT}" at ${MIN_MS}-${MAX_MS}ms · watching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet"}\nCommands: on, off, status, check, watch #channel, unwatch #channel`;
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
    text: state.armed ? "ON" : "OFF",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${state.armed ? "🟢 *ON*: claiming the next lead" : "🔴 *OFF*"}\nWatching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet (type `watch #your-leads-channel`)"}` } },
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
      const { messages = [] } = await slack("conversations.history", SLACK_USER_TOKEN, { channel, oldest: state.armedAt, limit: 50 }, 7000);
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
every(() => slack("auth.test", SLACK_USER_TOKEN, {}, 4000).catch(() => {}), 15000); // keep the connection warm: no slow handshake when a lead lands

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

function onMessage(msg) {
  lastActivity = Date.now();
  if (msg.type === "events_api" && msg.payload.event?.type === "message") {
    const e = msg.payload.event;
    if (e.channel === CONTROL_CHANNEL) control(e);
    else claim(e).catch((err) => log("claim error:", err.message));
  }
  if (msg.type === "interactive" && msg.payload.user?.id === CLAIM_USER_ID) {
    const a = msg.payload.actions?.[0]?.action_id;
    if (a === "on" || a === "off") {
      if (a === "on") arm();
      else { state.armed = false; save(); }
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
      try {
        const msg = JSON.parse(m.data);
        if (msg.envelope_id) sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack immediately
        if (msg.type === "disconnect") return sock.close();
        onMessage(msg);
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
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { stopping = true; try { child && child.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
  }
  run();
}

if (require.main === module) {
  if (process.env.BOT_CHILD) {
    startTimers();
    connect();
  } else {
    supervise();
  }
}
module.exports = { claim, state, arm, slack, calibrate, pickReplyCount, config }; // for tests
