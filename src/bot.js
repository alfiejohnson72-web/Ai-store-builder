// Wires the pieces together: Slack client, saved state, claimer, Bot Control, health checks and the live connection.
const { createSlack } = require("./slack");
const { createStore } = require("./store");
const { createPanel } = require("./panel");
const { createClaimer } = require("./claimer");
const { createHealth } = require("./health");
const { createControl } = require("./control");
const { createSocket } = require("./socket");
const { log: defaultLog } = require("./log");

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createBot(config, { slack = createSlack(), log = defaultLog, sleep = realSleep, rand = Math.random, WebSocketImpl } = {}) {
  const store = createStore(config.stateFile, {
    armed: false,
    armedAt: "0",
    leadBotId: null,
    ignoredUsers: [],
    ignoredNames: [],
    channels: config.channels,
    delayMs: null, // null = use REPLY_DELAY_MS from .env
    panelTs: null,
  }, log);

  const say = (text, thread_ts) =>
    slack.call("chat.postMessage", config.botToken, { channel: config.controlChannel, text, thread_ts }).catch((e) => log("say failed:", e.message));

  // Tell you in Bot Control when something is wrong, but not more than once per 10 minutes per problem.
  const alerted = new Map();
  function alertOnce(key, text) {
    if (Date.now() - (alerted.get(key) || 0) < 600000) return;
    alerted.set(key, Date.now());
    say(text);
  }

  const ctx = { config, slack, store, log, say, alertOnce, sleep, rand };
  const panel = createPanel(ctx);
  const claimer = createClaimer({ ...ctx, panel });
  const health = createHealth(ctx);
  const control = createControl({ ...ctx, panel, claimer, health });

  function handleMessage(msg) {
    if (msg.type === "events_api") {
      const e = msg.payload && msg.payload.event;
      if (!e || e.type !== "message") return;
      if (e.channel === config.controlChannel) control.handle(e);
      else claimer.claim(e).catch((err) => log("claim error:", err.message));
    } else if (msg.type === "interactive") {
      control.handleButton(msg.payload);
    }
  }

  const socket = createSocket({
    open: () => slack.call("apps.connections.open", config.appToken),
    onMessage: handleMessage,
    log,
    WebSocketImpl,
    onReady: async (first) => {
      await health.calibrate();
      if (first) {
        await say("👋 Lead claimer is online.");
        panel.refresh();
        health.selfCheck().catch((e) => log("check failed:", e.message));
      }
      claimer.catchUp().catch(() => {}); // anything that landed while we were offline
    },
  });

  const timers = [];
  function start() {
    const every = (fn, ms) => timers.push(setInterval(() => Promise.resolve().then(fn).catch(() => {}), ms));
    every(claimer.catchUp, 1200);
    every(() => store.state.armed && health.calibrate(), 180000); // keep the clock fresh while ON
    every(() => store.state.armed && slack.call("auth.test", config.userToken, {}, 4000), 3000); // keep the connection to Slack warm so the reply never waits for a new handshake
    every(() => store.state.armed && health.warnIfNotReady("Bot is ON"), 300000);
    socket.start();
  }
  function stop() {
    timers.splice(0).forEach(clearInterval);
    socket.stop();
  }

  return { start, stop, handleMessage, store, claimer, control, panel, health, socket };
}

module.exports = { createBot };
