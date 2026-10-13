// Claiming: when ON, the next lead in a watched channel gets a "t" in its thread (as you), then the bot turns itself OFF.
const { explain, FATAL } = require("./slack");
const { fullText, isLeadAlert, isIgnored, pickReplyCount } = require("./leads");

const CLAIM_TEXT = "t"; // the reply is always exactly "t"

function createClaimer({ config, slack, store, log, say, alertOnce, sleep, panel, rand = Math.random }) {
  const { state, save } = store;
  const post = (e) => slack.call("chat.postMessage", config.userToken, { channel: e.channel, thread_ts: e.ts, text: CLAIM_TEXT }, 4000);
  const delayMs = () => state.delayMs ?? config.replyDelayMs;

  function arm() {
    if (!state.armed) state.armedAt = (slack.clock.slackNow() / 1000 - 1).toFixed(6); // Slack's clock, 1s margin
    state.armed = true;
    save();
  }
  function disarm() {
    state.armed = false;
    save();
  }

  function isClaimable(e) {
    if (!state.armed || !state.channels.includes(e.channel)) return false;
    if (e.subtype && !["bot_message", "file_share"].includes(e.subtype)) return false; // edits, joins, etc.
    if (e.user === config.userId) return false;
    if (e.thread_ts && e.thread_ts !== e.ts) return false; // already a reply
    if (isIgnored(e, state)) return false; // never reply to people on the list (the bot stays ON for the next lead)
    if (!isLeadAlert(e, { leadBotId: state.leadBotId, leadBotName: config.leadBotName })) return false; // only lead alerts
    if (config.matcher && !config.matcher.test(fullText(e))) return false;
    return true;
  }

  // One immediate attempt, then up to 2 quick retries on errors that might go away.
  async function postWithRetry(e) {
    for (let i = 0; ; i++) {
      try {
        return { ...(await post(e)), tries: i + 1 };
      } catch (err) {
        if (i >= 2 || FATAL.test(err.message)) throw err;
        await sleep(120 * (i + 1));
      }
    }
  }

  async function alreadyReplied(e) {
    try {
      const r = await slack.call("conversations.replies", config.userToken, { channel: e.channel, ts: e.ts, limit: 50 }, 4000);
      return (r.messages || []).some((m) => m.ts !== e.ts && m.user === config.userId);
    } catch {
      return false;
    }
  }

  // Follow-up "t"s after the first, a fraction of a second apart. Never affects the claim itself.
  async function sendFollowUps(e, count) {
    for (let i = 1; i < count; i++) {
      await sleep(250 + rand() * 550);
      try {
        await post(e);
      } catch (err) {
        log("follow-up t failed:", err.message);
        return;
      }
    }
  }

  // Timed mode: wait so the reply LANDS delay ms after the lead by Slack's clock (it lands about half a round trip after it leaves).
  async function waitUntilDue(leadMs, delay) {
    const oneWay = Number.isFinite(slack.clock.minRtt) ? slack.clock.minRtt / 2 : 0;
    const wait = leadMs + delay - oneWay - slack.clock.slackNow();
    if (wait > 0) await sleep(Math.min(wait, delay + 1000));
  }

  async function claim(e) {
    if (!isClaimable(e)) return false;
    state.armed = false; // synchronous: guarantees only ONE lead is claimed per On
    const leadMs = Number(e.ts) * 1000;
    const delay = delayMs();

    if (delay > 0) {
      let manual = false;
      alreadyReplied(e).then((v) => (manual = v)); // checked while we wait; never holds up the reply
      await waitUntilDue(leadMs, delay);
      if (manual) {
        save();
        say(`ℹ️ Skipped: you already replied to that lead in <#${e.channel}>. Now OFF.`);
        panel.refresh();
        return false;
      }
    }

    const sending = postWithRetry(e); // in flight before anything else happens
    save(); // the disk write happens while the reply is on its way
    let sent;
    try {
      sent = await sending;
    } catch (err) {
      if (!(await alreadyReplied(e))) {
        state.armed = true; // failed: stay ON (same start time) so the next lead, or a retry of this one, is still claimed
        save();
        log("Claim failed:", err.message);
        say(`⚠️ Claim failed in <#${e.channel}>: ${explain(err.message)}. Still ON.`);
        panel.refresh();
        return false;
      }
      sent = { ts: null }; // Slack was slow to answer, but the reply did land
    }

    if (!state.leadBotId && e.bot_id) { state.leadBotId = e.bot_id; save(); } // lock onto the lead app
    const count = pickReplyCount(rand);
    sendFollowUps(e, count).catch((err) => log("follow-ups error:", err.message)); // runs in the background
    const landed = sent.ts ? Math.round(Number(sent.ts) * 1000 - leadMs) : null;
    const when = landed === null ? "Slack was slow to confirm it" : `first one ${landed}ms after it was posted${delay ? `, target ${delay}ms` : ""}`;
    log(`Claimed ${e.channel} ${e.ts}: ${when} (${count} t's)`);
    say(`⚡ Claimed 1 lead in <#${e.channel}>: replied "${CLAIM_TEXT}" ${count > 1 ? `x${count} ` : ""}(${when}). Now OFF.`);
    panel.refresh();
    return true;
  }

  // Safety net: while ON, also read the watched channels directly, in case a live event never arrives.
  let polling = false;
  let pausedUntil = 0;
  let fails = 0; // consecutive failed backup checks
  async function catchUp() {
    if (!state.armed || polling || Date.now() < pausedUntil) return;
    polling = true;
    try {
      for (const channel of [...state.channels]) {
        if (!state.armed) break;
        const { messages = [] } = await slack.call("conversations.history", config.userToken, { channel, oldest: state.armedAt, limit: 50 }, 7000);
        for (const m of messages.reverse()) {
          if (!state.armed) break;
          await claim({ ...m, channel });
        }
      }
      fails = 0;
    } catch (err) {
      fails++;
      pausedUntil = Date.now() + (fails > 1 ? 10000 : 2000); // don't hammer Slack while it's failing
      log("catchUp:", err.message);
      // One slow answer is normal (the live connection still works). Only warn if it keeps failing.
      if (fails >= 3) alertOnce("poll:" + explain(err.message), `⚠️ Backup check has failed ${fails} times in a row: ${explain(err.message)}. The main connection may still be fine. Type \`check\` for details.`);
    } finally {
      polling = false;
    }
  }

  return { claim, catchUp, arm, disarm, delayMs, CLAIM_TEXT };
}

module.exports = { createClaimer, CLAIM_TEXT };
