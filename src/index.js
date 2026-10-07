require("dotenv").config();
const { App } = require("@slack/bolt");
const { WebClient } = require("@slack/web-api");

const {
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_USER_TOKEN,
  CLAIM_USER_ID,
  CLAIM_CHANNELS = "",
  CLAIM_TEXT = "Claimed ✋ I'm on it.",
} = process.env;

for (const [k, v] of Object.entries({ SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_USER_TOKEN, CLAIM_USER_ID })) {
  if (!v) throw new Error(`Missing env var ${k} (see .env.example)`);
}

const channels = new Set(CLAIM_CHANNELS.split(",").map((s) => s.trim()).filter(Boolean));
const userClient = new WebClient(SLACK_USER_TOKEN); // posts as you
const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });

const claimed = new Set(); // thread_ts already claimed

app.event("message", async ({ event }) => {
  // Only new top-level messages from other people; skip edits, bots, and your own posts.
  if (event.subtype || event.bot_id || event.user === CLAIM_USER_ID) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return; // already a reply
  if (channels.size && !channels.has(event.channel)) return;
  if (claimed.has(event.ts)) return;
  claimed.add(event.ts);

  try {
    await userClient.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: CLAIM_TEXT });
    console.log(`Claimed ${event.channel} ${event.ts}`);
  } catch (err) {
    claimed.delete(event.ts);
    console.error("Claim failed:", err.data?.error || err.message);
  }
});

(async () => {
  await app.start();
  console.log("Thread claimer running (socket mode).");
})();
