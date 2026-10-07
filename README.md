# Slack Lead Claimer

When a new lead lands in a channel you're watching, this replies **"T"** in its thread as you, within a second. You manage it from your own **Bot Control** channel. No SDK, no dependencies (Node 22+, works on Mac and Windows).

## Setup
1. Create a private channel called **Bot Control**.
2. https://api.slack.com/apps → **Create New App → From manifest** → paste `manifest.json`.
3. **Basic Information → App-Level Tokens**: create one with `connections:write` → `SLACK_APP_TOKEN`.
4. **Install to Workspace**. Copy the Bot token (`xoxb-`) and User token (`xoxp-`).
5. In Bot Control run `/invite @Lead Claimer`. Invite it to each lead channel too.
6. `cp .env.example .env` and fill it in (`CONTROL_CHANNEL` = Bot Control's channel ID: View details, bottom of the pane).
7. `npm start` and leave it running.

## Commands (type in Bot Control; only you are obeyed)
- `watch #opt-in-1`: start claiming leads there
- `unwatch #opt-in-1`
- `pause` / `resume`
- `status`

Bot- or form-posted leads are claimed too. Set `CLAIM_MATCH` (regex) if a channel has non-lead chatter.
