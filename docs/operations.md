# Operations guide

Running, configuring, and troubleshooting Max day to day.

## Deploy

Railway, deploying from the `main` branch of this repo. Nixpacks builds
Python 3.12 + Node 22 (`nixpacks.toml` adds ffmpeg); `python main.py`
starts everything. Attach a volume and point `DATABASE_PATH` inside it so
settings, memory, and pressure state survive redeploys. **Every merge to
`main` auto-deploys** — treat main as production.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token (shared by bot + voice sidecar) |
| `OWNER_ID` | yes | your Discord user id — management commands are owner-only |
| `OPENROUTER_API_KEY` | yes | all AI chat/classification/drafting |
| `OPENROUTER_MODEL` | no | default model (per-guild override in dashboard) |
| `DASHBOARD_PASSWORD` | yes | dashboard login |
| `SECRET_KEY` | yes | session signing + sidecar↔bot internal auth (voice needs it) |
| `DATABASE_PATH` | yes | e.g. `/data/bot.db` on the volume |
| `TRANSCRIPTION_API_KEY` | for voice | OpenAI (default) or Groq key |
| `TRANSCRIPTION_API_URL` / `TRANSCRIPTION_MODEL` | no | e.g. Groq: `https://api.groq.com/openai/v1` + `whisper-large-v3` |
| `FISH_API_KEY` / `FISH_VOICE_ID` | for nice TTS | fish.audio key + voice reference id |
| `FISH_TTS_MODEL` | no | default `s2.1-pro-free` |
| `GITHUB_TOKEN` | no | higher rate limit for repo analysis |
| `MIN_UTTERANCE_SEC` / `MIN_UTTERANCE_RMS` | no | voice noise gates (1.5 / 300) |
| `SIDECAR_PORT` | no | sidecar control API port (8091) |

## Daily controls

**Dashboard** (your Railway domain, phone-friendly):
- Overview → **Restart bot** (full container restart, ~30s)
- Voice tab → live transcription console, **Start/Stop** listening,
  status badge (listening / idle / stopped)
- Logs tab → last 1000 log lines, level + text filters, live
- Settings → persona, AI model, wake words via `/wakewords`, automod,
  welcome, presence

**Slash commands (owner):** `/restart`, `/voicejoin`, `/voiceleave`,
`/wakewords`, `/memory` (show/wipe), `/pressure` (snapshot / on-off), plus
all the moderation/channel/role commands.

**Talking to Max:** the owner can just ask him — he has direct tools for
moderation, channels, roles, and messaging.

## Health signals

- `main` logger heartbeat every 5 min: `gateway ok, latency, guilds`
- `listener` heartbeat every 5 min: voice connection state, stream count
- Silent logs = the watchdog will force-restart within ~6 minutes;
  if heartbeats flow but a feature misbehaves, filter the Logs tab by its
  logger name (`voice`, `listener`, `proactive`, `memory`, `ai`)

## Troubleshooting quick hits

| Symptom | First moves |
|---|---|
| Bot silent everywhere | Logs tab reachable? If not: Railway logs; watchdog should self-restart. Else check `gateway not healthy` warnings |
| Doesn't join voice | Voice tab badge says? `transcription off` → key missing. `stopped` → hit Start. Logs: `listener` lines tell the join story |
| Transcripts wrong/noisy | Raise `MIN_UTTERANCE_SEC`/`MIN_UTTERANCE_RMS`; check `dropped` lines in logs |
| 401 from transcription | key/URL mismatch (OpenAI key with Groq URL is the classic) |
| No TTS voice | `Fish Audio TTS 4xx` in logs → key/voice-id/model; falls back to edge-tts silently |
| Max interjects too much/little | `/pressure` snapshot shows live pressures + reasons; tune `pressure/config.py`; `/pressure enabled:false` is the kill switch |
| Voice replies not spoken | sidecar must be connected to that channel — `voice playback skipped` in logs says so |

## Recurring maintenance

None required. Memory consolidates itself; pressure state decays; logs
ring-buffer; SQLite files stay small. Update dependencies deliberately —
`discord.py` and `discord-ext-voice-recv`/`@discordjs/voice` versions are
load-bearing (see `docs/voice-pipeline.md`).
