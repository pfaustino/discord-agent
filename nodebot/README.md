# nodebot — Max, rebuilt in Node.js

Fresh rebuild of Max from scratch, one layer at a time. This replaces the
Python bot (`bot/`) — not a second bot, not running alongside it. When this
is ready, it takes over and the Python code goes away.

## Current layer: connect + slash commands + text/voice AI chat + tools + persistence + moderation

- `src/index.js` — client, logs in, opens the DB, handles slash commands,
  messages, and voice state updates
- `src/commands/ping.js` — `/ping`, proves the slash-command path works
- `src/commands/voicejoin.js` / `voiceleave.js` — owner-only, pin/unpin the
  voice channel to listen in
- `src/commands/kick.js` `ban.js` `unban.js` `timeout.js` `untimeout.js`
  `warn.js` `warnings.js` `clearwarnings.js` `purge.js` `slowmode.js`
  `lock.js` `unlock.js` — ported from the Python bot's moderation.py,
  owner-only via `utils.js`'s `requireOwner` (one inline check per command
  file rather than a cog-level interaction_check, since commands here are
  flat files, not a cog), logged via `utils.js`'s `logAction` (mod_logs +
  an embed to the configured log channel, same as bot/utils.py's
  log_action) — the first thing to actually exercise db.js's
  warnings/mod_logs tables
- `src/load-commands.js` — drops a new file in `src/commands/` to add a
  command, nothing else to wire up
- `src/deploy-commands.js` — registers commands with Discord
- `src/db.js` — SQLite persistence via `node:sqlite` (built into Node 22,
  zero native dependency to install/compile), same schema shape as the
  Python bot's db.py: per-guild settings, durable/profile memory + version
  history, the permanent chat-log/turns table, manuscripts, knowledge base,
  warnings, mod logs. IDs are stored as TEXT, not INTEGER like db.py —
  Discord snowflakes exceed `Number.MAX_SAFE_INTEGER`, and discord.js
  already hands them out as strings. Functions are synchronous
  (`DatabaseSync`, not a Promise API) since embedded SQLite has no real
  async I/O to await — same reasoning better-sqlite3 (the standard
  userland alternative) uses.
- `src/openrouter.js` — OpenRouter chat client with the tool-calling agent
  loop (ported from openrouter.py — the junk-verdict re-roll and spend-cap
  breaker are Python-side free-model-pool spend controls, deliberately not
  carried over yet, this is the core loop) and abort-signal cancellation
  (needed for voice's cancel words to actually stop an in-flight reply)
- `src/tools.js` — AI-callable tools: `web_search` (DuckDuckGo) so far;
  GitHub/sandbox/moderation tools follow once their own identity/write
  pieces exist here
- `src/knowledge.js` — `kb_search`/`kb_list`/`kb_save`: procedural memory
  ("how to do X"), guild-scoped, backed by db.js, ported from the Python
  bot's knowledge.py — separate from tools.js because these need a guildId
  the generic tool dispatch doesn't carry, same reason the Python bot
  routes kb_* calls separately from its generic tools.run_tool
- `src/persona.js` — the default system prompt; `ai_system_prompt` in
  guild_settings overrides it per guild once set (no dashboard yet to set
  it from — that's later — but `/knowledge` proves the pattern works)
- `src/conversation.js` — **the actual point of this rebuild**: one shared
  per-guild turn buffer, not a separate one per modality. The Python bot's
  text history (ai.py) and voice transcript (voice.py) were two different
  in-memory structures the model never saw both of for immediate context —
  that's the "he doesn't know what I said in text when I ask in voice" gap.
  Both text and voice write into and read from this one buffer now — the
  gap is closed, not just narrowed. (Short-term/in-process, separate from
  db.js's permanent turns table — that's still a later layer.)
- `src/textChat.js` — replies when @mentioned (with tools + knowledge
  base), checks `ai_enabled`/`ai_model`/`ai_system_prompt` per guild,
  remembers every message (mentioned or not) into the shared buffer,
  tagged with which channel it happened in (`[#general]`) the same way the
  Python bot's memory does
- `src/transcription.js` — speech-to-text against any OpenAI-compatible
  `/audio/transcriptions` endpoint (OpenAI Whisper, Groq, ...)
- `src/tts.js` — Fish Audio when configured, free Microsoft Edge Read Aloud
  (via `msedge-tts`) otherwise; strips voice delivery tags for text display
- `src/voice.js` — join/leave/rebalance is adapted directly from
  `listener/index.js`'s proven DAVE E2EE join/capture (no reason to
  rewrite working audio plumbing) — what's new is that transcription, wake
  words, replies (with tools + knowledge base), and TTS all happen
  in-process now instead of over an HTTP bridge to a separate Python
  process, and read/write the same `conversation.js` buffer text chat
  uses. Respects `quiet_mode` (leaves/won't join, drops utterances during
  the gap before the next sweep) and per-guild wake/cancel words from
  db.js. Wake-word cooldown, a 1s grace window + cancel words ("never
  mind") that abort even an in-flight reply via `AbortController`, and
  repeated-blip suppression are all ported from the Python bot's voice.py.

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

Needs `ffmpeg` on PATH for TTS playback (same as `listener/`) — already
provided by the repo's root `nixpacks.toml` in the Railway environment
this runs alongside.

## Test

```bash
npm test
```

Real automated tests (`node --test`, no extra dependency), not just manual
smoke checks: the shared conversation buffer (text+voice ordering,
per-guild isolation, capping), the full db.js persistence layer against a
real temp-file SQLite database (settings/DEFAULTS fallback, memory version
archiving, manuscripts, knowledge base, turns durability/permanent log,
warnings, mod logs), knowledge.js's slugify/formatting/dispatch, WAV
encoding correctness, voice-tag stripping, wake/cancel-word matching,
owner-check logic (including `requireOwner`'s allow/deny branches),
`logAction` against a real DB with fake guild/channel objects (records to
mod_logs regardless of a log channel, posts an embed when one's configured
and reachable, degrades quietly when it isn't), the tool-calling agent
loop's control flow (mocked fetch), and web_search's formatting (injected
fake search function). Moderation commands themselves aren't yet
unit-tested end-to-end (that needs fuller Discord.js object mocking —
member/ban/timeout calls, `interaction.deferReply`, etc.) — `requireOwner`
and `logAction`, the two pieces every one of them shares, are.

A couple of things can't be exercised live from this sandbox and are
tested via dependency injection / mocked fetch instead, noted in the test
files themselves: `duckduckgo.com` is blocked by this environment's
network egress allowlist (confirmed via a raw fetch returning 403 "Host
not in allowlist" — a testing-environment restriction, not a bug, same
category as an earlier restriction hit calling api.github.com and
discord.com directly), and OpenRouter itself isn't called live either
(tests set a fake `OPENROUTER_API_KEY` and mock global `fetch` to test the
loop's control flow, not real API reachability).

## Known gaps in this layer, on purpose

- Only one non-knowledge-base AI tool so far (`web_search`) — moderation
  actions exist now as slash commands, but not yet as AI-callable tools
  (the owner asking Max in chat/voice to kick someone doesn't work yet,
  only `/kick` does). GitHub read/write and sandbox tools need their own
  identity/write layer that doesn't exist here yet. `recall_chat_log`
  (search the permanent chat log) needs the turns table wired into
  conversation.js — schema exists, wiring doesn't yet.
- No channel/role management commands (createchannel, giverole, ...) yet.
- Settings exist (db.js) but there's no dashboard to set most of them from
  yet, beyond what `/knowledge` and the moderation commands' `log_channel`
  setting prove out — wake/cancel words still fall back to env vars until
  a guild has its own row.
- No welcome/goodbye messages, autorole, or automod (banned words, invite
  blocking, mention spam) yet.
- No banned-word flagging or de-escalation/pressure (proactive speech) in
  voice yet.
- Single default persona unless `ai_system_prompt` is set directly in the
  DB — no per-guild dashboard UI for it yet.
- Moderation commands aren't unit-tested end-to-end yet (see Test section
  above) — only the shared owner-check/logging pieces are.

## Next layers (pick and choose, in whatever order makes sense)

- give the AI moderation/management tools (agent_tools.py's equivalent) so
  the owner can ask Max in chat/voice to kick/ban/etc., not just `/command`
- channel/role management commands + welcome/goodbye + automod
- more AI tools: GitHub read (then write), sandbox, `recall_chat_log`
- dashboard

## Cutover

When this covers what you need: stop the Python process, point Railway's
start command at this instead, done.
