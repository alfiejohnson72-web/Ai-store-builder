// The On/Off panel in Bot Control. Each refresh posts a fresh panel at the bottom and deletes the previous one,
// so the channel only ever holds one panel and it is always within reach.
function createPanel({ config, slack, store, log }) {
  const { state, save } = store;
  let chain = Promise.resolve();

  const delayText = () => {
    const ms = state.delayMs ?? config.replyDelayMs;
    return ms ? `about ${ms}ms after the lead` : "instantly";
  };

  function refresh() {
    chain = chain
      .then(async () => {
        const old = state.panelTs;
        const watching = state.channels.map((c) => `<#${c}>`).join(", ") || "nothing yet (type `watch #your-leads-channel`)";
        const r = await slack.call("chat.postMessage", config.botToken, {
          channel: config.controlChannel,
          text: state.armed ? "ON" : "OFF",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `${state.armed ? "🟢 *ON*: claiming the next lead" : "🔴 *OFF*"}\nWatching: ${watching}\nReplying: ${delayText()}` } },
            { type: "actions", elements: [
              { type: "button", action_id: "on", text: { type: "plain_text", text: "On" }, style: "primary" },
              { type: "button", action_id: "off", text: { type: "plain_text", text: "Off" }, style: "danger" },
            ] },
          ],
        });
        state.panelTs = r.ts;
        save();
        if (old) slack.call("chat.delete", config.botToken, { channel: config.controlChannel, ts: old }).catch(() => {});
      })
      .catch((e) => log("panel failed:", e.message));
    return chain;
  }

  return { refresh, delayText };
}

module.exports = { createPanel };
