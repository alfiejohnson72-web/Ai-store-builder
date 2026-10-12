// Guided setup: asks for your three Slack keys, checks them with Slack, saves .env, then starts the bot.
// Run it with:  node src/setup.js
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { Writable } = require("node:stream");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

// ---------- tiny helpers ----------
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = readline.createInterface({ input: process.stdin, output: out, terminal: !!process.stdin.isTTY });
let finishedInput = false;
rl.on("close", () => { if (!finishedInput) { console.log("\nSetup was interrupted before it finished. Nothing was changed."); process.exit(1); } });
const ask = (question, hidden = false) =>
  new Promise((resolve) => {
    process.stdout.write(question);
    muted = hidden;
    rl.question("", (answer) => { muted = false; process.stdout.write("\n"); resolve(answer.replace(/\s+/g, "")); });
  });
const askLine = (question) =>
  new Promise((resolve) => { process.stdout.write(question); rl.question("", (a) => resolve(a.trim())); });

function parseEnv(text) {
  const o = {};
  for (const line of (text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}

async function slack(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json;
}

const PLAIN = {
  token_revoked: "that key was revoked: make a fresh one (Reinstall to Workspace) and copy it again",
  invalid_auth: "that key is not right: copy it again from Slack",
  account_inactive: "that key belongs to an inactive account",
  not_authed: "that key is not right: copy it again from Slack",
  channel_not_found: "your account can't see that channel",
  missing_scope: "the app is missing a permission: save the App Manifest, then Reinstall to Workspace",
};
const why = (e) => PLAIN[e.message] || e.message;

async function main() {
  const old = parseEnv(fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "");
  console.log("\n=== Lead Claimer setup ===\n");
  console.log("I will ask for 3 keys. Copy each one from Slack, click here, paste it, then press Enter.");
  console.log("You will NOT see the key appear on screen when you paste. That is normal and keeps it private.\n");

  // Asks until a key with the right start is pasted. Empty or wrong pastes just re-ask (nothing aborts).
  // After 2 failed tries the paste is shown on screen, in case the hidden box is the problem.
  async function askKey(label, prefixes, hint) {
    let tries = 0;
    for (;;) {
      const v = await ask("   Paste it, then press Enter: ", tries < 2);
      if (prefixes.some((p) => v.startsWith(p))) { console.log(`   Got it: ${v.slice(0, 5)}... (${v.length} characters).\n`); return v; }
      tries++;
      console.log(v ? `   That starts with "${v.slice(0, 5)}", not ${prefixes[0]}. ${hint}` : `   Nothing arrived. Click this window, then press Cmd+V (Ctrl+V on Windows), then Enter.`);
      if (tries === 2) console.log("   (From now on you will SEE what you paste, so we can tell what is wrong.)");
      console.log("");
    }
  }

  console.log("1 of 3. APP token (starts with xapp-)");
  console.log("   Get it: https://api.slack.com/apps/A0C7LJX5UAY/general  ->  App-Level Tokens  ->  socket  ->  Copy");
  const app = await askKey("APP", ["xapp-"], "Copy the App-Level Token.");

  console.log("2 of 3. BOT token (starts with xoxb-)");
  console.log("   Get it: https://api.slack.com/apps/A0C7LJX5UAY/install-on-team  ->  Bot User OAuth Token  ->  Copy");
  let bot = await askKey("BOT", ["xoxb-", "xoxp-"], "Copy the Bot User OAuth Token.");

  console.log("3 of 3. USER token (starts with xoxp-)");
  console.log("   Get it: the same page  ->  User OAuth Token  ->  Copy");
  let usr = await askKey("USER", ["xoxp-", "xoxb-"], "Copy the User OAuth Token.");

  if (bot.startsWith("xoxp-") && usr.startsWith("xoxb-")) { [bot, usr] = [usr, bot]; console.log("(You pasted the bot and user keys the wrong way round. I fixed that.)\n"); }

  const problems = [];
  if (!app.startsWith("xapp-")) problems.push("The APP token must start with xapp-");
  if (!bot.startsWith("xoxb-")) problems.push("The BOT token must start with xoxb-");
  if (!usr.startsWith("xoxp-")) problems.push("The USER token must start with xoxp-");
  if (problems.length) { console.log("Problem:\n - " + problems.join("\n - ") + "\n\nRun the same command again and paste the right keys.\n"); process.exit(1); }

  // The three IDs: keep the ones already saved, otherwise ask.
  let userId = old.CLAIM_USER_ID, control = old.CONTROL_CHANNEL, channels = old.CLAIM_CHANNELS;
  if (!userId) userId = await askLine("Your Slack member ID (starts with U): ");
  if (!control) control = await askLine("The bot-controll channel ID (starts with C): ");
  if (!channels) channels = await askLine("The lead channel ID to watch (optin-leads-1, starts with C; or leave empty): ");

  console.log("Checking your keys with Slack...");
  let bad = false;
  if (process.env.SETUP_SKIP_CHECK) {
    console.log("  (check skipped)");
  } else {
    try { await slack("apps.connections.open", app); console.log("  ✅ APP token works"); } catch (e) { bad = true; console.log(`  ❌ APP token: ${why(e)}`); }
    try { await slack("auth.test", bot); console.log("  ✅ BOT token works"); } catch (e) { bad = true; console.log(`  ❌ BOT token: ${why(e)}`); }
    try {
      const a = await slack("auth.test", usr);
      console.log(`  ✅ USER token works (account: ${a.user})`);
      if (userId && a.user_id !== userId) console.log(`  ⚠️  Your member ID (${userId}) is not this account's ID (${a.user_id}). I will use ${a.user_id}.`), (userId = a.user_id);
      for (const c of (channels || "").split(",").map((s) => s.trim()).filter(Boolean)) {
        try { await slack("conversations.history", usr, { channel: c, limit: 1 }); console.log(`  ✅ Can read the lead channel (${c})`); } catch (e) { console.log(`  ⚠️  Cannot read ${c}: ${why(e)}`); }
      }
    } catch (e) { bad = true; console.log(`  ❌ USER token: ${why(e)}`); }
  }
  if (bad) {
    console.log("\nOne or more keys did not work, so I did NOT save anything.");
    console.log("Fix: go to https://api.slack.com/apps/A0C7LJX5UAY/install-on-team , click Reinstall to Workspace, Allow, then copy the keys again and re-run this command.\n");
    process.exit(1);
  }

  if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, ENV_FILE + ".bak");
  const lines = [`SLACK_APP_TOKEN=${app}`, `SLACK_BOT_TOKEN=${bot}`, `SLACK_USER_TOKEN=${usr}`, `CLAIM_USER_ID=${userId}`, `CONTROL_CHANNEL=${control}`];
  if (channels) lines.push(`CLAIM_CHANNELS=${channels}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  console.log("\n✅ Saved your settings.");

  finishedInput = true;
  rl.close();
  if (process.env.SETUP_NO_START) return;
  console.log("Starting the bot now. Keep this window open. In Slack, bot-controll will say 'Lead claimer is online'; then press On.\n");
  const args = [process.execPath, "--env-file=.env", path.join("src", "index.js")];
  const child = process.platform === "darwin"
    ? spawn("caffeinate", ["-i", ...args], { cwd: ROOT, stdio: "inherit" })
    : spawn(args[0], args.slice(1), { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code || 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(); } catch {} setTimeout(() => process.exit(0), 300); });
}

main().catch((e) => { console.error("Setup stopped:", e.message); process.exit(1); });
