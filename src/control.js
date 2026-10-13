// Bot Control: text commands and the On/Off buttons. Only you (CLAIM_USER_ID) are obeyed.
const { NEVER_REPLY_NAMES } = require("./leads");
const { isValidDelay, MAX_DELAY_MS } = require("./config");

const HELP = "Commands: on, off, status, check, ping, watch #channel, unwatch #channel, ignore @person, unignore @person, ignored, delay <ms|instant|default>, forgetbot";

function createControl({ config, store, say, log, panel, claimer, health }) {
  const { state, save } = store;
  const seen = new Set(); // the same message arrives as both a bot event and a user event

  const background = (fn) => fn().catch((e) => log("check failed:", e.message));
  const list = (ids, fmt) => ids.map(fmt).join(", ");

  function handle(e) {
    if (e.user !== config.userId || e.subtype || e.bot_id) return;
    if (seen.has(e.ts)) return;
    seen.add(e.ts);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    const text = (e.text || "").trim();
    const channels = [...text.matchAll(/<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
    const users = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
    const rest = text.replace(/^\S+\s*/, "").replace(/<[@#][^>]*>/g, "").replace(/\s+/g, " ").trim();
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const { reply, after } = run(cmd, { channels, users, rest });
    if (reply) say(reply, e.ts);
    panel.refresh();
    if (after) background(after);
  }

  function run(cmd, { channels, users, rest }) {
    switch (cmd) {
      case "on":
        claimer.arm();
        return { reply: "🟢 ON: will claim the next lead, then turn off", after: () => health.warnIfNotReady("Bot is ON") };
      case "off":
        claimer.disarm();
        return { reply: "🔴 OFF" };
      case "watch":
        if (!channels.length) return { reply: "Type: watch #channel (pick it from Slack's list)" };
        for (const id of channels) if (!state.channels.includes(id)) state.channels.push(id);
        save();
        return { reply: `✅ Watching ${list(channels, (i) => `<#${i}>`)}`, after: health.selfCheck };
      case "unwatch":
        if (!channels.length) return { reply: "Type: unwatch #channel" };
        state.channels = state.channels.filter((c) => !channels.includes(c));
        save();
        return { reply: `🛑 Stopped watching ${list(channels, (i) => `<#${i}>`)}` };
      case "ignore":
      case "unignore":
        return ignore(cmd, users, rest);
      case "ignored":
        return { reply: `🚫 Never replying to: ${[...NEVER_REPLY_NAMES, ...state.ignoredNames, ...state.ignoredUsers.map((u) => `<@${u}>`)].join(", ")}` };
      case "forgetbot":
        state.leadBotId = null;
        save();
        return { reply: "🔓 Forgot AIBot's app ID. It will learn it again from the next claimed lead." };
      case "delay":
        return delay(rest);
      case "check":
        return { after: health.selfCheck };
      case "ping":
        return { after: health.ping };
      case "status":
        return {
          reply: `${state.armed ? "🟢 ON" : "🔴 OFF"} · reply "${claimer.CLAIM_TEXT}" ${panel.delayText()} · watching: ${state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet"} · replies only to ${state.leadBotId ? "AIBot (locked to its app ID)" : "AIBot"}\n${HELP}`,
        };
      default:
        return {}; // anything else just brings the panel back to the bottom
    }
  }

  function ignore(cmd, users, name) {
    if (!users.length && !name) return { reply: `Type: ${cmd} @person   (or: ${cmd} Their Name)` };
    const who = [...users.map((u) => `<@${u}>`), name].filter(Boolean).join(", ");
    if (cmd === "ignore") {
      for (const u of users) if (!state.ignoredUsers.includes(u)) state.ignoredUsers.push(u);
      if (name && !state.ignoredNames.some((n) => n.toLowerCase() === name.toLowerCase())) state.ignoredNames.push(name);
      save();
      return { reply: `🚫 I will never reply to: ${who}` };
    }
    state.ignoredUsers = state.ignoredUsers.filter((u) => !users.includes(u));
    state.ignoredNames = state.ignoredNames.filter((n) => n.toLowerCase() !== name.toLowerCase());
    save();
    return { reply: `✅ Removed from the never-reply list: ${who}` };
  }

  function delay(arg) {
    const a = arg.toLowerCase().replace(/ms$/, "");
    if (a === "default") state.delayMs = null;
    else if (a === "instant" || a === "0") state.delayMs = 0;
    else if (isValidDelay(Number(a)) && a !== "") state.delayMs = Number(a);
    else return { reply: `Type: delay instant, delay 800 (ms after the lead, up to ${MAX_DELAY_MS}), or delay default` };
    save();
    return { reply: `⏱️ Replying ${panel.delayText()}` };
  }

  // The On/Off buttons on the panel.
  function handleButton(payload) {
    if (!payload || !payload.user || payload.user.id !== config.userId) return;
    const action = payload.actions && payload.actions[0] && payload.actions[0].action_id;
    if (action === "on") {
      claimer.arm();
      panel.refresh();
      background(() => health.warnIfNotReady("Bot is ON"));
    } else if (action === "off") {
      claimer.disarm();
      panel.refresh();
    }
  }

  return { handle, handleButton };
}

module.exports = { createControl };
