# Discord Agent

A Python Discord bot that manages your server end-to-end, with a mobile-friendly web
dashboard and AI chat powered by OpenRouter. Designed to deploy on Railway from GitHub
as a single service (bot + dashboard in one process).

Docs: [overview](docs/overview.md) · [architecture](docs/architecture.md) ·
[voice pipeline](docs/voice-pipeline.md) · [operations](docs/operations.md) ·
[how Max thinks](docs/how-max-thinks.md) (concepts: pressure, memory,
tools, wake pipeline, prompts, models, limitations, roadmap)

## Features

**Bot (slash commands)**
- Moderation: `/kick` `/ban` `/unban` `/timeout` `/untimeout` `/warn` `/warnings`
  `/clearwarnings` `/purge` `/slowmode` `/lock` `/unlock`
- Roles: `/giverole` `/takerole` `/createrole` `/deleterole`
- Channels: `/createchannel` `/deletechannel` `/settopic`
- Utility: `/ping` `/serverinfo` `/userinfo` `/say`
- AI: `/ask`, `/aireset`, `/manuscript`, and the bot replies whenever
  it's @mentioned
- AI tools: DuckDuckGo web search, GitHub repo analysis (share a repo link
  and the bot pulls its stats, languages, and README to discuss it), and
  full read-only visibility into the bot's own GitHub repo — every branch,
  contributor pull requests with full diffs, branch comparisons, commits,
  and file contents at any ref, for reviewing contributor work together
  in chat. Read-only, no create/update/delete/merge call anywhere in that
  path — merging is always a human decision.
- Repo sandbox (owner-only, for now): hand Max a repo link and, once you
  confirm, he clones it into a disposable E2B cloud sandbox — never onto the
  machine he runs on — installs it, runs it, screenshots what's running back
  to the channel, edits files as you direct, and pushes to GitHub when you
  tell him to. One sandbox per channel; needs `E2B_API_KEY` and
  `GITHUB_WRITE_TOKEN`. Costs cents per session (usage-based).
- Document review: drop a file on a message that mentions the bot (or in
  an always-on AI channel) — text, markdown, code, PDFs, and Word docs are
  read automatically and folded into the conversation so the bot can
  summarize, answer questions about, or review what's in them.
- Proactive speech: a pressure engine (`pressure/`, adapted from
  digital-pressure) lets the bot speak unprompted — messages and voice
  transcripts are classified into weighted signals (blockers, wrong claims,
  promised follow-ups, safety concerns…); pressure charges, decays, and
  flows, and a deterministic gate (thresholds, relevance, novelty,
  cooldowns, budgets, energy) rules on every drafted contribution —
  `/pressure` shows state or toggles it (owner)
- Persistent memory, updated live: a working-memory file (current topic,
  open questions, recent meaningful turns), a durable-memory file (dated
  facts/preferences/decisions with confidence), and a per-member profile
  card (goals, active projects, constraints, vibe notes, freeform notes)
  are all rewritten after every single turn — text or voice, from anyone,
  in every channel, tagged with exactly where it happened (`#general`,
  `voice/General`, ...) — so something posted in one channel can be
  recalled later from a completely different channel or from voice, no
  batching delay; stored versioned in SQLite, injected into every reply;
  `/memory` shows or wipes it (owner). Every raw turn is also persisted
  immediately (before consolidation runs) and kept forever as a permanent,
  searchable chat log — if a redeploy hits mid-consolidation, unconsolidated
  turns are replayed on restart instead of lost, and the bot can search the
  actual log (`recall_chat_log`) whenever a summary alone doesn't have it
- Manuscript (owner-only, always on — no toggle, nothing to remember to
  enable): every word the owner says, voice or text, is separately kept
  verbatim — for long-form stuff meant to be kept word for word, like a
  life story or a book draft, instead of boiled down into a fact or a
  profile field. Completely separate from durable memory and profile
  cards, never summarized, compressed, or rewritten. `/manuscript` sends
  it back as a text file, or clears it
- Voice monitoring (hybrid): a Node.js sidecar (`listener/`) joins occupied
  voice channels — it speaks Discord's DAVE E2EE voice protocol via
  discord.js, which Python libraries don't support yet — receives each
  speaker separately, and streams utterances to the Python bot, which
  transcribes them, flags banned words to the mod log, and joins the
  conversation (text + TTS) when someone says a wake word — `/voicejoin`
  `/voiceleave` `/wakewords` (needs `TRANSCRIPTION_API_KEY` and
  `SECRET_KEY`; announces itself in the channel when it starts listening)
- Welcome/goodbye messages + autorole for new members
- Automod: banned words, invite-link blocking, mention-spam limits
- Mod log channel + persistent action history

**Dashboard** (mobile-first, works great from a phone)
- Overview: server + bot stats
- Members: search, warn/timeout/kick/ban, edit roles
- Server: create/delete channels & roles, send messages as the bot
- Mod: warning list, full moderation log
- Settings: welcome, automod, AI model/prompt/channels, log channel, bot presence

## Setup

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → copy the **Token** (this is `DISCORD_TOKEN`).
3. On the same tab, enable **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
4. **OAuth2 → URL Generator**: check `bot` + `applications.commands` scopes, and give it
   **Administrator** (or the specific permissions you want). Open the generated URL to
   invite the bot to your server.

### 2. Get an OpenRouter key

Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) — this is `OPENROUTER_API_KEY`.

### 3. Deploy on Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and pick it.
3. Add these variables (service → **Variables**):

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | your bot token |
   | `OWNER_ID` | your Discord user ID (management commands are owner-only) |
   | `OPENROUTER_API_KEY` | your OpenRouter key |
   | `DASHBOARD_PASSWORD` | password for the dashboard |
   | `SECRET_KEY` | any long random string |
   | `DATABASE_PATH` | `/data/bot.db` |
   | `GITHUB_TOKEN` | *(optional)* GitHub token — raises the repo-analysis API rate limit |
   | `E2B_API_KEY` | *(optional)* [e2b.dev](https://e2b.dev) key — enables the repo sandbox tools |
   | `GITHUB_WRITE_TOKEN` | *(optional)* GitHub token with push access — lets the sandbox push changes |
   | `TRANSCRIPTION_API_KEY` | *(optional)* OpenAI or Groq key — enables voice monitoring |
   | `FISH_API_KEY` | *(optional)* fish.audio key — natural TTS voice for spoken replies |
   | `FISH_VOICE_ID` | *(optional)* fish.audio voice model reference id to speak with |
   | `FISH_TTS_MODEL` | *(optional)* fish.audio model, default `s2.1-pro-free` (free tier) |

4. Attach a **Volume** to the service mounted at `/data` (so settings/warnings survive
   redeploys).
5. Settings → **Networking → Generate Domain** to get your dashboard URL.

Open the domain on your phone, log in with `DASHBOARD_PASSWORD`, and manage everything
from there.

### Run locally

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows (source .venv/bin/activate on mac/linux)
pip install -r requirements.txt
copy .env.example .env        # fill it in, then load it into your shell
python main.py
```

Dashboard: http://localhost:8000

> Note: locally the session cookie is marked `secure`, which most browsers still accept
> on `localhost`. Slash commands are synced per-guild on startup, so they appear
> immediately in servers the bot is already in.

## Notes

- All state lives in one SQLite file (`DATABASE_PATH`). Without a Railway volume it
  resets on each deploy.
- AI model, system prompt, and always-on AI channels are per-server settings in the
  dashboard. Any [OpenRouter model ID](https://openrouter.ai/models) works.
- The dashboard is a single password for full control — use a strong one, and keep the
  Railway domain private.
- Management commands (moderation, roles, channels, welcome, `/say`) only work for the
  user whose ID is in `OWNER_ID`. AI chat (`/ask`, @mentions) and info commands
  (`/ping`, `/serverinfo`, `/userinfo`) are open to everyone.
