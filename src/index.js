// Zero-dependency Slack lead claimer: Socket Mode over WebSocket + Web API over fetch.
// Press On in Bot Control -> claims the NEXT lead in watched channels with a lowercase "t" (as you), then turns itself off.
// This file is the entry point: the parent process only supervises, and the bot itself runs in a child it restarts.
const { loadConfig } = require("./config");
const { createBot } = require("./bot");
const { log } = require("./log");

const BAD_CONFIG = 78; // child exit code meaning "fix .env", so the supervisor doesn't restart it forever

function runBot() {
  // Never die: log and carry on.
  process.on("uncaughtException", (e) => log("Unexpected error (kept running):", e && e.message));
  process.on("unhandledRejection", (e) => log("Unexpected rejection (kept running):", e && e.message));
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(BAD_CONFIG);
  }
  createBot(config).start();
}

// Runs the bot as a child process and restarts it within 2 seconds if it ever exits for any reason.
function supervise() {
  try {
    loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { spawn } = require("node:child_process");
  let stopping = false;
  let child = null;
  const run = () => {
    child = spawn(process.execPath, [__filename], { stdio: "inherit", env: { ...process.env, BOT_CHILD: "1" } });
    child.on("exit", (code, signal) => {
      if (stopping) process.exit(0);
      if (code === BAD_CONFIG) process.exit(1);
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
  if (process.env.BOT_CHILD) runBot();
  else supervise();
}
