# nodebot — Max, rebuilt in Node.js

Fresh rebuild of Max from scratch, one layer at a time. This replaces the
Python bot (`bot/`) — not a second bot, not running alongside it. When this
is ready, it takes over and the Python code goes away.

## Current layer: connect + one command

- `src/index.js` — client, logs in, handles slash commands
- `src/commands/ping.js` — `/ping`, proves the whole path works
- `src/load-commands.js` — drops a new file in `src/commands/` to add a
  command, nothing else to wire up
- `src/deploy-commands.js` — registers commands with Discord

## Run it

```bash
cd nodebot
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, OWNER_ID, DEV_GUILD_ID
npm run deploy-commands
npm start
```

Uses the same token, same application, same bot identity as the live
Python bot — because it's not a different bot, it's Max being rebuilt.
Only run one of them connected at a time (Python bot stopped, or this one
stopped) so there's a single brain answering.

## Next layers (pick and choose, in whatever order makes sense)

Nothing here yet — added as each one gets built:
- moderation commands
- persona / AI chat
- persistence (settings, warnings, mod log)
- voice (join, transcribe, TTS)
- dashboard
- memory
- whatever else Max needs

## Cutover

When this covers what you need: stop the Python process, point Railway's
start command at this instead, done.
