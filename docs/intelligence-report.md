# Codebase intelligence report — initial deliverable

Produced by the read-only introspection system (`introspect.py`). Scope:
this repository, working tree, all branches read-only. Excluded: `.env*`,
databases, key material, logs, `node_modules`, `data/`, generated files.
Everything below is recommendation only — no change happens without human
approval. **Verified** = read from code; **assumption** = inference.

## 1. Architecture map

See `docs/architecture.md` for the full map. One paragraph: a single
supervised process tree runs the Python bot (chat/persona, moderation,
memory, pressure-driven proactive speech), a FastAPI dashboard, and a
Node voice sidecar (the only DAVE-capable voice path), talking over a
localhost API authed by `SECRET_KEY`. State lives in SQLite on a volume.
Key flows (verified): audio → sidecar noise gates → `/internal/utterance`
→ transcription → junk filters → transcript/mod-flags/memory/pressure →
wake or proactive response → text + TTS pushback. Discord event → cog
check (`is_owner`/`owner_only`) → action → `log_action` → mod log + DB.
Dashboard mute → `quiet_mode` set + sidecar `/leave` → utterances dropped,
replies suppressed → sidecar sweep rejoins on unmute.

## 2. Dependency & security review

Python: `discord.py>=2.7.1` (DAVE floor, load-bearing), `fastapi`,
`uvicorn`, `aiosqlite`, `httpx`, `ddgs`, `edge-tts`. Node:
`discord.js` 14, `@discordjs/voice` 0.19, `@snazzah/davey`,
`@discordjs/opus`, `prism-media`, `sodium-native`. No known-vulnerable
pins (assumption — no automated audit runs; see recommendation #6).

Security posture (verified): dashboard uses one shared password and a
signed cookie; internal API requires `SECRET_KEY`; owner-gating on
management commands; secrets only via env. Privacy: voice capture is
announced, mute genuinely tears down the subscription, transcripts are
in-memory only — but transcript text appears in the dashboard log buffer.

## 3. Top 10 improvement opportunities

| # | Finding (file) | Why it matters | Recommendation | Impact/Risk/Effort/Confidence |
|---|---|---|---|---|
| 1 | `/api/login` has no rate limit (`web/api.py`, `web/auth.py`) | single shared password + public URL = brute-forceable | add per-IP backoff/lockout | high/low/small/high |
| 2 | `/internal/*` is served on the public port (`web/app.py`) | auth is one shared header secret; narrower is safer | reject non-loopback client IPs in `_auth` | high/low/small/high |
| 3 | pressure store is sync `sqlite3` called from the event loop (`pressure/store.py`) | brief loop stalls under load; latency spikes elsewhere | `asyncio.to_thread` wrapper or aiosqlite port | med/low/med/high |
| 4 | `openrouter.chat` has no retry (`openrouter.py`) | one 502 = dropped reply/classification | bounded retry w/ backoff on 5xx/timeouts | med/low/small/high |
| 5 | transcript text flows into dashboard logs (`voice.py` log.info → `logbuffer.py`) | privacy surface wider than the console tab | log utterance metadata only, or a redact toggle | med/low/small/med |
| 6 | no dependency audit automation | vulnerable pins would go unnoticed | GitHub Dependabot/`npm audit`+`pip-audit` in CI | med/low/small/high |
| 7 | no tests for cogs/web/sidecar (only `pressure/tests`) | regressions land silently; see §5 | start with web auth + utterance pipeline tests | high/low/med/high |
| 8 | duplicated JSON-extraction helpers (`memory.py`, `bot/cogs/proactive.py`) | drift risk in parsing behavior | shared `jsonutil.py` | low/low/small/high |
| 9 | per-channel dicts never pruned (`voice.py` transcripts, `proactive.py` context) | slow memory growth on channel churn (assumption: minor at this scale) | prune on channel delete event | low/low/small/med |
| 10 | classification cost is per-message with only a 5s/channel cap (`proactive.py`) | busy servers multiply model calls | batch classify every N messages; heuristics pre-filter | med/med/med/med |

All require human approval; none are urgent-critical (verified: no
secrets in repo, no injection paths found in `esc()`-escaped dashboard).

## 4. Integration candidates worth investigating

- **faster-whisper (local)** — kills per-minute transcription cost;
  costs CPU on the container. Migration: swap `transcription.py` backend.
- **Discord native AutoMod rules** — offload banned-word matching to
  Discord for text (voice stays ours). Low effort, less latency.
- **sentence-transformers embeddings** — real topic similarity for the
  pressure engine's relevance scoring instead of token overlap. Medium
  effort; adds a model to the image.
- **Sentry (or similar)** — error aggregation beyond the log ring buffer.
  Small effort, immediate visibility win.
- **SQLite WAL mode** — cheap concurrency headroom for all three DB users.

## 5. Prioritized testing gaps

1. Web API: auth (login/lockout), settings round-trip, internal auth 401s
2. Voice pipeline: utterance → filters → transcript/flag/wake (stub STT)
3. Proactive: classify→ingest→gate→speak with stubbed model (exists as a
   rehearsal script in session history; make it a real test)
4. Memory: consolidation JSON parsing edge cases
5. Sidecar: none exist and node testing is heavier — smoke-test the
  control API contract at minimum

## 6. Safe phased roadmap

- **Phase 1 (safety):** #1, #2, #5 + test gap 1 — hardening, no behavior change
- **Phase 2 (reliability):** #3, #4, #6 + test gaps 2-4
- **Phase 3 (quality):** #8, #9, embeddings relevance spike, dashboard pressure panel
- **Phase 4 (cost/scale):** #10, faster-whisper evaluation

Each phase ships independently; nothing here touches main, tokens, data,
or the deployment without explicit approval of the specific change.
