# Slack Lead Claimer

When a new lead from **AIBot** lands in a channel you're watching, this replies a lowercase **t** in its thread as you, the instant it arrives. You manage it from your own **Bot Control** channel. No SDK, no dependencies (Node 22+, works on Mac and Windows).

## Setup
1. Create a private channel called **Bot Control**.
2. https://api.slack.com/apps → **Create New App → From manifest** → paste `manifest.json`.
3. **Basic Information → App-Level Tokens**: create one with `connections:write` → `SLACK_APP_TOKEN`.
4. **Install to Workspace**. Copy the Bot token (`xoxb-`) and User token (`xoxp-`).
5. In Bot Control run `/invite @Lead Claimer`. Invite it to each lead channel too.
6. `npm run setup` (asks for the three keys, checks them with Slack, saves `.env` and starts the bot).
   Or by hand: `cp .env.example .env`, fill it in, then `npm start` and leave it running.

## Using it
The bot keeps one panel at the bottom of Bot Control with **On** and **Off** buttons.
1. Type `watch #optin-1` once (pick the channel from Slack's dropdown).
2. Press **On**. It claims the **next one lead** with a lowercase `t` as you, then turns itself off and tells you how fast the reply landed.
3. Press **On** again for the next lead.

Only messages posted by the AIBot app are claimed (never people, never other apps). After the first claim it locks onto AIBot's exact app ID (`forgetbot` undoes that).

| Command | What it does |
| --- | --- |
| `on` / `off` | Same as the buttons |
| `status` | Shows ON/OFF, reply speed, watched channels, and all commands |
| `watch #channel` / `unwatch #channel` | Choose the lead channels |
| `ignore @person` or `ignore Their Name` | Never reply to leads from or naming them (`unignore` to undo, `ignored` to list) |
| `delay instant` / `delay 800` / `delay default` | Reply instantly, or so the reply lands about 800ms after the lead |
| `check` | Tests every key and channel |
| `ping` | Measures the round trip to Slack from where the bot runs |

Only you (`CLAIM_USER_ID`) are obeyed. Set `CLAIM_MATCH` (regex) if AIBot also posts things that aren't leads.

## How it stays reliable
- Listens live over Socket Mode and, while ON, also re-reads the watched channels every 1.2s in case a live event goes missing.
- When Slack refreshes the connection (or nothing has been heard for 3 minutes) a new connection is opened *before* the old one closes, so there is never a gap.
- If a reply fails it stays ON and retries; if Slack times out but the reply did land, it counts the claim.
- A supervisor restarts the bot within 2 seconds if it ever exits. A broken `.env` stops it with a clear list of what to fix.

## Running on a server in Virginia (fastest)
1. Render dashboard -> **New +** -> **Blueprint** -> connect this repository (GitHub).
2. Render reads `render.yaml` and asks for the six values marked `sync: false` (the three Slack keys, `CLAIM_USER_ID`, `CONTROL_CHANNEL`, `CLAIM_CHANNELS`).
3. Apply. Open the worker's **Logs**; wait for "Connected.". In Bot Control, press **On**.
4. Type `ping` in Bot Control to see the round trip to Slack from the server, and compare with your own computer.
Stop any copy running on your own computer first: only one copy may run at a time.

## Code
`src/index.js` (entry + supervisor) → `bot.js` wires: `config.js`, `slack.js` (API + Slack clock), `store.js` (`state.json`), `leads.js` (what counts as a lead), `claimer.js`, `control.js` (commands), `panel.js`, `health.js` (checks/ping), `socket.js` (connection). `npm test` runs the tests against a fake Slack.
