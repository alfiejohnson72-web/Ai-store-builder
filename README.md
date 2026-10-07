# Slack Lead Claimer

When a new lead lands in a channel you're watching, this replies a lowercase **t** in its thread as you, within a second. You manage it from your own **Bot Control** channel. No SDK, no dependencies (Node 22+, works on Mac and Windows).

## Setup
1. Create a private channel called **Bot Control**.
2. https://api.slack.com/apps → **Create New App → From manifest** → paste `manifest.json`.
3. **Basic Information → App-Level Tokens**: create one with `connections:write` → `SLACK_APP_TOKEN`.
4. **Install to Workspace**. Copy the Bot token (`xoxb-`) and User token (`xoxp-`).
5. In Bot Control run `/invite @Lead Claimer`. Invite it to each lead channel too.
6. `cp .env.example .env` and fill it in (`CONTROL_CHANNEL` = Bot Control's channel ID: View details, bottom of the pane).
7. `npm start` and leave it running.

## Using it
The bot posts a panel in Bot Control with **On** and **Off** buttons.
1. Type `watch #optin-1` once (pick the channel from Slack's dropdown).
2. Press **On**. It claims the **next one lead** in optin-1 with a lowercase `t` as you, then turns itself off and tells you.
3. Press **On** again for the next lead.

Text commands (only you are obeyed): `on`, `off`, `status`, `watch #channel`, `unwatch #channel`.

Bot- or form-posted leads are claimed too. Set `CLAIM_MATCH` (regex) if a channel has non-lead chatter.
