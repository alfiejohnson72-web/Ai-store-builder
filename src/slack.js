// Slack Web API over fetch, plus a running estimate of Slack's clock so reply timings can be measured exactly.
function createSlack({ fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
  const clock = {
    offset: 0, // Slack's clock minus this machine's clock, in ms
    minRtt: Infinity, // quickest recent round trip, in ms
    slackNow: () => now() + clock.offset,
  };

  async function call(method, token, body, timeoutMs = 8000) {
    const t0 = now();
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`${method}: bad_response_${res.status}`);
    }
    if (!json.ok) throw new Error(`${method}: ${json.error}`);
    if (method === "chat.postMessage" && json.ts) learnClock(t0, now(), Number(json.ts) * 1000);
    return json;
  }

  // Slack stamps a message about halfway through the round trip. Quick round trips are trusted most.
  function learnClock(t0, t1, stampedMs) {
    const rtt = t1 - t0;
    const sample = stampedMs - (t0 + t1) / 2;
    const first = clock.minRtt === Infinity;
    clock.minRtt = Math.min(clock.minRtt * 1.02, rtt);
    const w = first ? 1 : rtt <= clock.minRtt * 1.3 ? 0.5 : 0.15;
    clock.offset = clock.offset * (1 - w) + sample * w;
  }

  return { call, clock };
}

// Errors that retrying can't fix.
const FATAL = /not_in_channel|channel_not_found|invalid_auth|token_revoked|account_inactive|missing_scope|is_archived/;

const HINTS = {
  channel_not_found: "your account can't see that channel (or the app needs Reinstall to Workspace after the permissions update)",
  missing_scope: "the app is missing a permission: save the new App Manifest, then Reinstall to Workspace",
  token_revoked: "that key was revoked: reinstall the app and copy fresh keys",
  account_inactive: "that key belongs to an inactive account: reinstall the app and copy fresh keys",
  invalid_auth: "that key is wrong: copy it again from Slack",
  not_in_channel: "the account/bot isn't in that channel",
};

// Turns a Slack error into a plain-English explanation.
function explain(msg) {
  if (/aborted due to timeout|timed out|fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(msg)) return "Slack or your internet was too slow to answer just then. This is usually temporary";
  const code = (msg.split(": ")[1] || "").trim();
  return HINTS[code] ? `${msg} (${HINTS[code]})` : msg;
}

module.exports = { createSlack, explain, FATAL };
