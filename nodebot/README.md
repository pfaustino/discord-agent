# nodebot — Max, rebuilt in Node.js

Fresh rebuild of Max from scratch, one layer at a time. This replaces the
Python bot (`bot/`) — not a second bot, not running alongside it. When this
is ready, it takes over and the Python code goes away.

## Current layer: connect + one command + text AI chat + voice

- `src/index.js` — client, logs in, handles slash commands, messages, and
  voice state updates
- `src/commands/ping.js` — `/ping`, proves the slash-command path works
- `src/commands/voicejoin.js` / `voiceleave.js` — owner-only, pin/unpin the
  voice channel to listen in
- `src/load-commands.js` — drops a new file in `src/commands/` to add a
  command, nothing else to wire up
- `src/deploy-commands.js` — registers commands with Discord
- `src/openrouter.js` — minimal OpenRouter chat client (no tool-calling
  yet — abort-signal cancellation is in, though, since voice needs it)
- `src/persona.js` — the system prompt, shared by text and voice so the two
  surfaces can't drift into different personas
- `src/conversation.js` — **the actual point of this rebuild**: one shared
  per-guild turn buffer, not a separate one per modality. The Python bot's
  text history (ai.py) and voice transcript (voice.py) were two different
  in-memory structures the model never saw both of for immediate context —
  that's the "he doesn't know what I said in text when I ask in voice" gap.
  Both text and voice write into and read from this one buffer now — the
  gap is closed, not just narrowed.
- `src/textChat.js` — replies when @mentioned, remembers every message
  (mentioned or not) into the shared buffer, tagged with which channel it
  happened in (`[#general]`) the same way the Python bot's memory does
- `src/transcription.js` — speech-to-text against any OpenAI-compatible
  `/audio/transcriptions` endpoint (OpenAI Whisper, Groq, ...)
- `src/tts.js` — Fish Audio when configured, free Microsoft Edge Read Aloud
  (via `msedge-tts`) otherwise; strips voice delivery tags for text display
- `src/voice.js` — join/leave/rebalance is adapted directly from
  `listener/index.js`'s proven DAVE E2EE join/capture (no reason to
  rewrite working audio plumbing) — what's new is that transcription, wake
  words, replies, and TTS all happen in-process now instead of over an
  HTTP bridge to a separate Python process, and read/write the same
  `conversation.js` buffer text chat uses. Wake-word cooldown, a 1s grace
  window + cancel words ("never mind") that abort even an in-flight reply
  via `AbortController`, and repeated-blip suppression are all ported from
  the Python bot's voice.py.

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
per-guild isolation, capping), WAV encoding correctness, voice-tag
stripping, wake/cancel-word matching, and owner-check logic.

## Known gaps in this layer, on purpose

- No tool-calling yet (web search, GitHub, sandbox, moderation actions,
  memory recall, knowledge base) — both text and voice give plain chat
  replies for now. Next layer.
- No persistence — settings (wake words, quiet mode, banned words),
  durable/profile memory, the manuscript, and the knowledge base don't
  exist here yet. Wake/cancel words are env-configured
  (`VOICE_WAKE_WORDS`/`VOICE_CANCEL_WORDS`) as a stand-in.
- No banned-word flagging or de-escalation/pressure (proactive speech) in
  voice yet — those need the tool-calling + persistence layers first.
- Single default persona (`persona.js`), not per-guild/dashboard-configurable.

## Next layers (pick and choose, in whatever order makes sense)

- tool-calling (web search, GitHub read/write, sandbox, moderation actions,
  memory recall, knowledge base) — the highest-value next layer, since
  voice and text both currently give plain replies with no ability to act
- persistence (settings, warnings, mod log, durable/profile memory,
  manuscript, knowledge base) — SQLite, same schema shape as db.py
- moderation commands
- dashboard

## Cutover

When this covers what you need: stop the Python process, point Railway's
start command at this instead, done.
