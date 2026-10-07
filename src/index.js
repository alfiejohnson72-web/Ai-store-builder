// Zero-dependency Slack thread claimer: Socket Mode over WebSocket + Web API over fetch.
const {
  SLACK_APP_TOKEN,
  SLACK_USER_TOKEN,
  CLAIM_USER_ID,
  CLAIM_CHANNELS = "",
  CLAIM_TEXT = "Claimed ✋ I'm on it.",
} = process.env;

for (const [k, v] of Object.entries({ SLACK_APP_TOKEN, SLACK_USER_TOKEN, CLAIM_USER_ID })) {
  if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
}

const channels = new Set(CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean));
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

async function claim(event) {
  if (event.subtype || event.bot_id || event.user === CLAIM_USER_ID) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (channels.size && !channels.has(event.channel)) return;
  if (claimed.has(event.ts)) return;
  claimed.add(event.ts);
  try {
    // Posted with the user token, so the reply appears as you.
    await slack("chat.postMessage", SLACK_USER_TOKEN, { channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT });
    console.log(`Claimed ${event.channel} ${event.ts}`);
  } catch (err) {
    claimed.delete(event.ts);
    console.error("Claim failed:", err.message);
  }
}

async function connect() {
  const { url } = await slack("apps.connections.open", SLACK_APP_TOKEN);
  const ws = new WebSocket(url);
  ws.onopen = () => console.log("Thread claimer connected.");
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack immediately
    if (msg.type === "events_api" && msg.payload.event?.type === "message") claim(msg.payload.event);
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
