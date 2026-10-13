// Checks that keys and channels work, measures speed to Slack, and keeps Slack's clock estimate fresh.
const os = require("node:os");
const { explain } = require("./slack");

function createHealth({ config, slack, store, say, log, sleep }) {
  const { state } = store;

  // Post and delete a tiny message in Bot Control so we learn Slack's clock precisely.
  async function calibrate() {
    try {
      const r = await slack.call("chat.postMessage", config.botToken, { channel: config.controlChannel, text: "·" }, 4000);
      slack.call("chat.delete", config.botToken, { channel: config.controlChannel, ts: r.ts }, 4000).catch(() => {});
    } catch (e) {
      log("calibrate:", e.message);
    }
  }

  // Full report in Bot Control: every key and every watched channel.
  async function selfCheck() {
    const lines = [];
    try {
      const a = await slack.call("auth.test", config.userToken);
      lines.push(`✅ Your account key works (${a.user})`);
      if (a.user_id !== config.userId) lines.push(`⚠️ CLAIM_USER_ID is not the account that owns your xoxp key (it is ${a.user_id})`);
    } catch (e) {
      lines.push(`❌ Your account key (xoxp): ${explain(e.message)}`);
    }
    try {
      await slack.call("auth.test", config.botToken);
      lines.push("✅ Bot key works");
    } catch (e) {
      lines.push(`❌ Bot key (xoxb): ${explain(e.message)}`);
    }
    for (const channel of state.channels) {
      try {
        await slack.call("conversations.history", config.userToken, { channel, limit: 1 });
        lines.push(`✅ Can read <#${channel}>`);
      } catch (e) {
        lines.push(`❌ Can't read <#${channel}>: ${explain(e.message)}`);
      }
    }
    if (!state.channels.length) lines.push("⚠️ Not watching any channel yet. Type: watch #your-leads-channel");
    await say(lines.join("\n"));
  }

  // Quick version used while ON, so a problem is reported BEFORE a lead arrives.
  async function readiness() {
    const bad = [];
    try { await slack.call("auth.test", config.userToken); } catch (e) { bad.push(`your account key: ${explain(e.message)}`); }
    try { await slack.call("auth.test", config.botToken); } catch (e) { bad.push(`bot key: ${explain(e.message)}`); }
    for (const channel of state.channels) {
      try { await slack.call("conversations.history", config.userToken, { channel, limit: 1 }); } catch (e) { bad.push(`<#${channel}>: ${explain(e.message)}`); }
    }
    if (!state.channels.length) bad.push("not watching any channel (type: watch #your-leads-channel)");
    return bad;
  }

  async function warnIfNotReady(prefix) {
    const bad = await readiness();
    if (bad.length) await say(`⚠️ ${prefix} but NOT READY, a lead would be missed:\n• ${bad.join("\n• ")}\nType \`check\` for details.`);
    return bad.length === 0;
  }

  // Measure the real round trip from wherever this bot runs to Slack (lower = faster).
  async function ping() {
    const times = [];
    for (let i = 0; i < 7; i++) {
      const t0 = Date.now();
      try {
        await slack.call("auth.test", config.userToken, {}, 4000);
        times.push(Date.now() - t0);
      } catch {}
      await sleep(120);
    }
    times.shift(); // the first call includes setting up the connection
    const where = process.env.RENDER ? "the Render server" : `this computer (${os.hostname()})`;
    if (!times.length) return say(`⚠️ Could not measure the speed to Slack from ${where}.`);
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    await say(`🏓 Round trip to Slack from ${where}: best ${Math.min(...times)}ms, average ${avg}ms, worst ${Math.max(...times)}ms. Lower is faster.`);
  }

  return { calibrate, selfCheck, readiness, warnIfNotReady, ping };
}

module.exports = { createHealth };
