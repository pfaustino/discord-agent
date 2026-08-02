# 03 — Running it

Authoritative for operations. `docs/operations.md` predates the Node cutover
and is wrong about the entry point; treat it as history.

## Deploy

Railway, from `main`. **Every merge to `main` auto-deploys — treat `main` as
production.**

Nixpacks builds it. The start command is:

```
node --experimental-sqlite nodebot/src/deploy-commands.js || echo 'skipped'
exec node --experimental-sqlite nodebot/src/index.js
```

Slash-command registration runs first and is allowed to fail — a Discord
outage at boot should not stop the bot from starting.

Three build details that were each a real incident:

- **`--experimental-sqlite` is required.** `node:sqlite` is "built into Node
  22" but was not switched on across all of it. Nixpacks resolves `nodejs_22`
  to a version inside that gap, so without the flag `db.js` dies at import
  with `ERR_UNKNOWN_BUILTIN_MODULE`.
- **`aptPkgs` includes `build-essential` and `python3`** for `node-gyp`.
  `@discordjs/opus` publishes no prebuild for this target, so it compiles from
  source. Python is a *build* dependency only — nothing runs Python at runtime.
- **`ffmpeg`** is needed for voice.

## Database

SQLite. **Attach a Railway volume and point `DATABASE_PATH` inside it** — e.g.
`/data/nodebot.db`. Without that, settings, memory, pressure state, credits and
accounts are wiped on every redeploy.

The bot warns loudly at startup if the database sits outside a mounted volume.
Believe the warning.

Do **not** point `DATABASE_PATH` at the Python bot's database. Both schemas use
the same table names, so `CREATE TABLE IF NOT EXISTS` would be a silent no-op
and the bot would come up looking healthy while mangling every Discord id past
2^53. `initDb` detects this and refuses to start, with migration instructions:

```
node nodebot/src/migrate-settings.js --from <old.db> --to /data/nodebot.db
```

## Environment

Required:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `OWNER_ID` | Your Discord user id — management tools are owner-only |
| `OPENROUTER_API_KEY` | All AI work |
| `DASHBOARD_PASSWORD` | Dashboard login (also the break-glass path) |
| `SECRET_KEY` | Signs dashboard and platform session cookies |
| `DATABASE_PATH` | Put it on the volume |

Worth setting:

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_MODEL` | `anthropic/claude-3.5-haiku` | Conversational model |
| `OPENROUTER_UTILITY_MODEL` | `openrouter/free` | Background work — see the trap below |
| `OPENROUTER_BG_HOURLY_CAP` | `240` | Background calls/hour — see the trap below |
| `OPENROUTER_FALLBACK_MODELS` | *(auto)* | Curate the switch-to shortlist |
| `TRANSCRIPTION_API_KEY` | — | Voice. OpenAI or Groq |
| `TRANSCRIPTION_API_URL` | `https://api.openai.com/v1` | Groq: `https://api.groq.com/openai/v1` |
| `TRANSCRIPTION_MODEL` | `whisper-1` | Groq: `whisper-large-v3-turbo` |
| `FISH_API_KEY` | — | Spoken replies. Without it, free edge-tts |
| `EDGE_TTS_VOICE` | `en-US-GuyNeural` | Free-voice selection |
| `BRAVE_SEARCH_API_KEY` | — | Web search — see the trap below |
| `PLATFORM_STAFF_EMAILS` | — | Staff bootstrap. Leave empty when self-hosting |
| `DISCORD_CLIENT_SECRET` | — | "Sign in with Discord" on the dashboard |

## Known traps

These are not hypothetical. Each has happened.

### The free-model pool has a daily cap, and the breaker does not know about days

`OPENROUTER_UTILITY_MODEL` defaults to `openrouter/free`, which routes across
OpenRouter's free pool. That pool is capped **per day**: 50 requests, or 1,000
once the account has bought $10 of credits at any point.

`OPENROUTER_BG_HOURLY_CAP` defaults to 240/hour — **5,760/day against a
1,000/day allowance.** The breaker is tuned to the wrong axis entirely, so it
burns the whole day's quota by midday and then every background call fails
until midnight:

```
[proactive] signal classification failed: OpenRouter rate limited
  (openrouter/free, background): Rate limit exceeded: free-models-per-day-high-balance
[memory] consolidation failed: ... same
```

Backend switching now reroutes around this automatically, so it is no longer
fatal. **The pacing is still wrong.** Until a daily-aware breaker exists,
setting `OPENROUTER_BG_HOURLY_CAP=40` spreads 1,000 calls across 24 hours
instead of spending them before lunch.

Note also that **failed attempts still count against the daily quota**, and a
failed background call still consumes an hourly budget slot.

### Web search is dead on Railway without a Brave key

`duck-duck-scrape` is blocked from datacenter IPs. The fallback chain is Brave
(needs `BRAVE_SEARCH_API_KEY`) → DDG scrape → DDG instant-answer API, and only
the first and last work from Railway. The instant-answer API returns an
abstract plus a few links — noticeably weaker than real search.

Free tier: <https://brave.com/search/api>. Without it, search technically works
and is quietly poor, which is worse than an obvious failure.

### Transcription is the most over-priced line you run

OpenAI's `whisper-1` is $0.006/min. Groq's `whisper-large-v3-turbo` is
$0.04/hour — about 9× cheaper, more accurate, and much faster. Both are
OpenAI-compatible, so the switch is three environment variables and no code
change. Caveat: Groq bills a 10-second minimum per request and the noise gate
passes utterances as short as 1.5s, so short utterances cost 2–3× nominal —
still far cheaper.

Self-hosting Whisper on Railway does **not** pay for itself. Railway is
CPU-only; matching current accuracy means `large-v3-turbo`, which needs ~3GB
resident 24/7 (~$30/month) before transcribing anything, and its marginal cost
barely undercuts Groq. It also makes transcription slower and, at smaller
model sizes, less accurate — which *raises* your LLM bill, because the
mention classifier fires more often on mangled names.

## Monitoring

There is no monitoring stack. That is the honest state — see
[06 — Operating model](06-operating-model.md), where uptime alerting and a
watch rotation are the first pieces of shared plumbing to build.

Today:

- `/health` returns `{ok, bot_ready}`.
- The dashboard's **Logs** tab reads an in-process ring buffer, which captures
  startup lines because logging is installed before anything else runs.
- Railway's own logs are the fallback.

What to actually watch for, in the absence of alerting:

| Symptom | Likely cause |
|---|---|
| `free-models-per-day` in logs | Daily quota — see above |
| Bot answers but never remembers | Consolidation failing; check background model |
| Voice joins but never responds | Transcription key/URL, or credit gate |
| "out of credits" in a customer server | Working as designed — issue credits |
| `[credits] failed to meter` | Ledger write failing. Gate fails open, so it is unbilled usage, not downtime |
| Dashboard 500s after redeploy | `DATABASE_PATH` outside the volume |

## Incidents

**Bot is down.** Railway restarts on failure up to 10 times. Check the deploy
log for `ERR_UNKNOWN_BUILTIN_MODULE` (missing `--experimental-sqlite`) or the
Python-database refusal.

**Bot is up but silent in a customer server.** Check the balance first — a
zero balance stops AI and leaves moderation running, by design. The bot says so
once an hour per guild.

**A model backend is rate limited.** It reroutes itself for background work and
offers a choice for conversational. Nothing to do unless every candidate is
parked, which is logged.

**A customer says they were billed wrong.** `usage_events` is append-only and
records the frozen price, real token counts and a provider request id per call.
`credit_grants` records every issuance with a payment reference. Between them
any balance is fully reconstructable.

## Backups

There are none. The database is one SQLite file on a Railway volume, and it now
holds customer accounts, order history and the credit ledger — the difference
between "restore from a redeploy" and "we lost what people paid us".

This is the highest-priority operational gap. A nightly `sqlite3 .backup` to
object storage would take an afternoon.

## Tests

```bash
cd nodebot && npm install && npm test
```

528 tests across 31 files, no network. They cover the ledger arithmetic, the
gate, the platform pipeline, backend switching, voice phrase matching, and the
dashboard over real HTTP against a real listening server.

Run them before merging to `main`, because `main` deploys itself.
