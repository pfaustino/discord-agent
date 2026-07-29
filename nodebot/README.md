# nodebot — Max, rebuilt in Node.js

Fresh rebuild of Max from scratch, one layer at a time. This replaces the
Python bot (`bot/`) — not a second bot, not running alongside it. When this
is ready, it takes over and the Python code goes away.

## Current layer: connect + one command + text AI chat

- `src/index.js` — client, logs in, handles slash commands and messages
- `src/commands/ping.js` — `/ping`, proves the slash-command path works
- `src/load-commands.js` — drops a new file in `src/commands/` to add a
  command, nothing else to wire up
- `src/deploy-commands.js` — registers commands with Discord
- `src/openrouter.js` — minimal OpenRouter chat client (no tool-calling yet)
- `src/conversation.js` — **the actual point of this rebuild**: one shared
  per-guild turn buffer, not a separate one per modality. The Python bot's
  text history (ai.py) and voice transcript (voice.py) were two different
  in-memory structures the model never saw both of for immediate context —
  that's the "he doesn't know what I said in text when I ask in voice" gap.
  Here there's exactly one buffer; text writes into it now, voice will
  later, both read from it.
- `src/textChat.js` — replies when @mentioned, remembers every message
  (mentioned or not) into the shared buffer, tagged with which channel it
  happened in (`[#general]`) the same way the Python bot's memory does

## Run it

```bash
cd nodebot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, OWNER_ID, DEV_GUILD_ID, OPENROUTER_API_KEY
npm run deploy-commands
npm start
```

Uses the same token, same application, same bot identity as the live
Python bot — because it's not a different bot, it's Max being rebuilt.
Only run one of them connected at a time (Python bot stopped, or this one
stopped) so there's a single brain answering.

## Next layers (pick and choose, in whatever order makes sense)

- voice (join, transcribe, TTS) — biggest lift, but `listener/` already has
  working DAVE E2EE join/capture in Node; adapt it in rather than
  rewriting from scratch. Once it writes into conversation.js the same way
  textChat.js does, the cross-modality gap is actually closed.
- tool-calling (web search, GitHub read/write, sandbox, moderation actions)
- persistence (settings, warnings, mod log, durable/profile memory,
  manuscript, knowledge base) — SQLite, same schema shape as db.py
- moderation commands
- dashboard

## Cutover

When this covers what you need: stop the Python process, point Railway's
start command at this instead, done.
