# Slack Thread Claimer

Watches channels and, the instant a new thread starts, replies in it **as you** (using your user token), built directly on Slack's Socket Mode and Web API with no SDK so you've claimed it first.

## Setup

2. **Basic Information → App-Level Tokens**: create one with `connections:write` → `SLACK_APP_TOKEN`.
3. **Install to Workspace**. Copy the User token (`xoxp-`).
4. Invite the bot to channels you want watched: `/invite @Thread Claimer`.
5. `cp .env.example .env`, fill it in (set `CLAIM_USER_ID` to your member ID so your own posts are ignored).
6. `npm start` (Node 22+, no dependencies)

Set `CLAIM_CHANNELS` to limit which channels are claimed and `CLAIM_TEXT` to change the reply.
