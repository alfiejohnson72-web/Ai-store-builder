// Zero-dependency Slack lead claimer: Socket Mode over WebSocket + Web API over fetch.
// Press On in Bot Control -> claims the NEXT lead in watched channels with a lowercase "t" (as you), then turns itself off.
const fs = require("node:fs");
const path = require("node:path");

const {
  SLACK_APP_TOKEN,
  SLACK_USER_TOKEN,
  SLACK_BOT_TOKEN,
  CLAIM_USER_ID,
  CONTROL_CHANNEL, // channel ID of "Bot Control"
  CLAIM_TEXT = "t",
  CLAIM_CHANNELS = "", // optional initial watch list (channel IDs, comma separated)
  CLAIM_MATCH = "", // optional regex: only messages matching it count as leads
} = process.env;

for (const [k, v] of Object.entries({ SLACK_APP_TOKEN, SLACK_USER_TOKEN, SLACK_BOT_TOKEN, CLAIM_USER_ID, CONTROL_CHANNEL })) {
  if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
}

const STATE_FILE = path.join(__dirname, "..", "state.json");
const state = { armed: false, channels: CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean) };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
} catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const matcher = CLAIM_MATCH ? new RegExp(CLAIM_MATCH, "i") : null;

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
  if (!state.armed || !state.channels.includes(event.channel)) return;
  if (event.subtype && event.subtype !== "bot_message") return; // edits, joins, etc.
  if (event.user === CLAIM_USER_ID) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (matcher && !matcher.test(fullText(event))) return;
  state.armed = false; // synchronous: guarantees only ONE lead is claimed
  const t0 = Date.now();
  const post = slack("chat.postMessage", SLACK_USER_TOKEN, { channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT });
  save(); // disk write happens while the reply is already in flight
  try {
    await post;
    console.log(`Claimed ${event.channel} ${event.ts} in ${Date.now() - t0}ms`);
    await say(`✅ Claimed 1 lead in <#${event.channel}> (replied "${CLAIM_TEXT}" in ${Date.now() - t0}ms). Now OFF.`);
  } catch (err) {
    state.armed = true; // failed: stay armed so the next lead is still claimed
    save();
    console.error("Claim failed:", err.message);
    say(`⚠️ Claim failed in <#${event.channel}>: ${err.message}. Still ON.`);
  }
  panel();
}

// Commands (only from you, only in Bot Control): on | off | watch #chan | unwatch #chan | status
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
  } else if (cmd === "on") {
    state.armed = true; save(); reply = "🟢 ON: will claim the next lead, then turn off";
  } else if (cmd === "off") {
    state.armed = false; save(); reply = "🔴 OFF";
  } else if (cmd === "status") {
    reply = `${state.armed ? "🟢 ON" : "🔴 OFF"} · reply "${CLAIM_TEXT}" · watching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet (type: watch #optin-1)"}`;
  } else {
    panel();
    return;
  }
  say(reply, event.ts);
  panel();
}

// Control panel with On/Off buttons, posted in Bot Control.
function panel() {
  return slack("chat.postMessage", SLACK_BOT_TOKEN, {
    channel: CONTROL_CHANNEL,
    text: state.armed ? "ON" : "OFF",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${state.armed ? "🟢 *ON*: claiming the next lead" : "🔴 *OFF*"}\nWatching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet (type `watch #optin-1`)"}` } },
      { type: "actions", elements: [
        { type: "button", action_id: "on", text: { type: "plain_text", text: "On" }, style: "primary" },
        { type: "button", action_id: "off", text: { type: "plain_text", text: "Off" }, style: "danger" },
      ] },
    ],
  }).catch((e) => console.error(e.message));
}

async function connect() {
  const { url } = await slack("apps.connections.open", SLACK_APP_TOKEN);
  const ws = new WebSocket(url);
  ws.onopen = () => {
    console.log("Lead claimer connected.");
    say("👋 Lead claimer is online.");
    panel();
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack immediately
    if (msg.type === "events_api" && msg.payload.event?.type === "message") {
      const e = msg.payload.event;
      if (e.channel === CONTROL_CHANNEL) control(e);
      else claim(e);
    }
    if (msg.type === "interactive" && msg.payload.user?.id === CLAIM_USER_ID) {
      const a = msg.payload.actions?.[0]?.action_id;
      if (a === "on" || a === "off") {
        state.armed = a === "on";
        save();
        panel();
      }
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
