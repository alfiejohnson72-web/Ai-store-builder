// Zero-dependency Slack lead claimer: Socket Mode over WebSocket + Web API over fetch.
// Replies "T" (as you) in the thread of every new lead in watched channels.
// Watched channels are managed by typing commands in your private "Bot Control" channel.
const fs = require("node:fs");
const path = require("node:path");

const {
  SLACK_APP_TOKEN,
  SLACK_USER_TOKEN,
  SLACK_BOT_TOKEN,
  CLAIM_USER_ID,
  CONTROL_CHANNEL, // channel ID of "Bot Control"
  CLAIM_TEXT = "T",
  CLAIM_CHANNELS = "", // optional initial watch list (channel IDs, comma separated)
  CLAIM_MATCH = "", // optional regex: only messages matching it count as leads
} = process.env;

for (const [k, v] of Object.entries({ SLACK_APP_TOKEN, SLACK_USER_TOKEN, SLACK_BOT_TOKEN, CLAIM_USER_ID, CONTROL_CHANNEL })) {
  if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
}

const STATE_FILE = path.join(__dirname, "..", "state.json");
const state = { paused: false, channels: CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean) };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
} catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const matcher = CLAIM_MATCH ? new RegExp(CLAIM_MATCH, "i") : null;
const claimed = new Set();

async function slack(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

const say = (text, thread_ts) =>
  slack("chat.postMessage", SLACK_BOT_TOKEN, { channel: CONTROL_CHANNEL, text, thread_ts }).catch((e) => console.error(e.message));

function fullText(e) {
  const parts = [e.text, ...(e.attachments || []).flatMap((a) => [a.pretext, a.title, a.text, a.fallback])];
  return parts.filter(Boolean).join("\n");
}

async function claim(event) {
  if (state.paused || !state.channels.includes(event.channel)) return;
  if (event.subtype && event.subtype !== "bot_message") return; // edits, joins, etc.
  if (event.user === CLAIM_USER_ID) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (matcher && !matcher.test(fullText(event))) return;
  if (claimed.has(event.ts)) return;
  claimed.add(event.ts);
  try {
    await slack("chat.postMessage", SLACK_USER_TOKEN, { channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT });
    console.log(`Claimed ${event.channel} ${event.ts}`);
  } catch (err) {
    claimed.delete(event.ts);
    console.error("Claim failed:", err.message);
    say(`⚠️ Claim failed in <#${event.channel}>: ${err.message}`);
  }
}

// Commands (only from you, only in Bot Control): watch #chan | unwatch #chan | pause | resume | status
function control(event) {
  if (event.user !== CLAIM_USER_ID || event.subtype || event.bot_id) return;
  const text = (event.text || "").trim();
  const ids = [...text.matchAll(/<#(C[A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const cmd = text.split(/\s+/)[0].toLowerCase();
  let reply;
  if (cmd === "watch" && ids.length) {
    for (const id of ids) if (!state.channels.includes(id)) state.channels.push(id);
    save();
    reply = `✅ Watching ${ids.map((i) => `<#${i}>`).join(", ")}`;
  } else if (cmd === "unwatch" && ids.length) {
    state.channels = state.channels.filter((c) => !ids.includes(c));
    save();
    reply = `🛑 Stopped watching ${ids.map((i) => `<#${i}>`).join(", ")}`;
  } else if (cmd === "pause") {
    state.paused = true; save(); reply = "⏸️ Paused";
  } else if (cmd === "resume") {
    state.paused = false; save(); reply = "▶️ Resumed";
  } else if (cmd === "status") {
    reply = `${state.paused ? "⏸️ Paused" : "▶️ Running"} · replying "${CLAIM_TEXT}" · watching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet"}`;
  } else {
    reply = "Commands: `watch #channel`, `unwatch #channel`, `pause`, `resume`, `status`";
  }
  say(reply, event.ts);
}

async function connect() {
  const { url } = await slack("apps.connections.open", SLACK_APP_TOKEN);
  const ws = new WebSocket(url);
  ws.onopen = () => console.log("Lead claimer connected.");
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack immediately
    if (msg.type === "events_api" && msg.payload.event?.type === "message") {
      const e = msg.payload.event;
      if (e.channel === CONTROL_CHANNEL) control(e);
      else claim(e);
    }
    if (msg.type === "disconnect") ws.close();
  };
  ws.onclose = () => {
    console.log("Disconnected, reconnecting...");
    setTimeout(() => connect().catch(retry), 1000);
  };
  ws.onerror = (e) => console.error("WebSocket error:", e.message || e);
}

function retry(err) {
  console.error("Connect failed:", err.message);
  setTimeout(() => connect().catch(retry), 3000);
}

connect().catch(retry);
