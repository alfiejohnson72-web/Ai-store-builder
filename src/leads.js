// Pure rules: what counts as a lead, who is never replied to, and how many "t"s to send.
const NEVER_REPLY_NAMES = ["Jase Chijioke"]; // built in: never reply to this person, or to alerts naming them

function fullText(e) {
  const parts = [e.text, ...(e.attachments || []).flatMap((a) => [a.pretext, a.title, a.text, a.fallback])];
  return parts.filter(Boolean).join("\n");
}

// A lead is ONLY a message posted by the lead app (AIBot). Messages from people and from any other app are never claimed.
// Once the first lead is claimed, the bot remembers the app's ID and from then on accepts only that exact app.
function isLeadAlert(e, { leadBotId, leadBotName }) {
  if (!e.bot_id) return false; // posted by a person, not an app
  if (leadBotId) return e.bot_id === leadBotId;
  const names = [e.bot_profile && e.bot_profile.name, e.username].filter(Boolean).map((n) => String(n).toLowerCase());
  if (names.length) return names.includes(leadBotName); // a name is shown: it must be the lead app
  return /new lead alert/i.test(fullText(e)); // no name shown by Slack: fall back on the alert text
}

// True if this message is from (or about) someone on the never-reply list.
function isIgnored(e, { ignoredUsers = [], ignoredNames = [] }) {
  if (e.user && ignoredUsers.includes(e.user)) return true;
  const hay = [fullText(e), e.username, e.bot_profile && e.bot_profile.name, e.user_profile && e.user_profile.real_name, e.user_profile && e.user_profile.display_name]
    .filter(Boolean).join("\n").toLowerCase();
  return [...NEVER_REPLY_NAMES, ...ignoredNames].some((n) => n && hay.includes(String(n).toLowerCase()));
}

// How many "t" replies to send: 20% just one, 80% two to four (max 4), like quick manual spamming.
function pickReplyCount(rand = Math.random) {
  const r = rand();
  if (r < 0.2) return 1;
  if (r < 0.6) return 2; // 40%
  if (r < 0.88) return 3; // 28%
  return 4; // 12%
}

module.exports = { NEVER_REPLY_NAMES, fullText, isLeadAlert, isIgnored, pickReplyCount };
