# 01 — The project

## In one breath

A Discord bot with a personality, a memory, and a voice — and, wrapped around
it, the machinery to sell that bot to other people as a service.

Those are two products in one repository, and it is worth being precise about
the seam between them, because most confusion about this project comes from
treating them as one thing.

**The bot** is a complete piece of software. It moderates a server, talks to
people in text and in voice, remembers what happened, and occasionally speaks
up on its own. It works perfectly well run by one person for one community,
and that is how it has run until now.

**The platform** is what turns that into a business: customer accounts, an
order form, a staff queue, a credit balance that meters what each bot spends,
and a dashboard that shows customers what they are using. None of it is
switched on for a self-hosted install.

The rest of this document describes the bot. [05 — Service model](05-service-model.md)
describes the business.

## What the bot does

**Talks like a specific person.** Mention it, or speak in a channel it has
been told to watch, and it replies in a persona the server owner controls.
The persona is deliberately split in two: *who it is* (editable, a matter of
taste) and *what it can do* (which tracks the actual code — see
[02 — How it works](02-how-it-works.md) for why that split has teeth).

**Runs the server.** 24 slash commands covering the usual moderation surface —
ban, kick, timeout, warn, purge, slowmode, lock, role and channel management,
warning history. The owner can skip the commands entirely and just say what
they want in plain language; the bot has direct tools for all of it. Everyone
else gets pointed at the slash commands, because the tools are owner-only.

**Sits in voice channels.** It joins occupied voice channels over Discord's
DAVE end-to-end-encrypted protocol, transcribes every speaker separately in
near-real-time, and joins the conversation out loud when addressed. After it
finishes speaking it keeps listening for 25 seconds, so people can carry on
talking without repeating a wake phrase. Saying "stop speaking" cuts it off
mid-sentence but keeps it in the conversation; "stop listening" ends the
conversation.

**Knows when it is being spoken to.** Exact wake phrases fire instantly, but
transcription mangles names — "hey Amy" comes back as "hey aim ee" often
enough to matter. A cheap classifier catches the mishearings, then the
conversational model decides whether the mention was an address or just
someone saying the name. That two-stage design exists because a single
eager model answers "they said my name, so yes" far too often.

**Remembers, continuously.** Two tiers: a working memory of the current
conversation and a durable memory of long-term facts. Both survive restarts.
Every turn is tagged with where it happened, so something said in `#general`
is in memory — labelled as `#general` — the next time it speaks in voice, and
the other way round. Text and voice share one conversation buffer; they are
not separate worlds.

**Speaks up unprompted, rarely.** A pressure engine watches for unresolved
blockers, wrong technical claims, stalled progress and safety concerns.
Pressure builds and decays across six reservoirs; crossing a threshold lets
the bot interject once, with something useful. Multiple gates stop it
repeating itself, spamming, or wading into a heated exchange. Off by default
per guild — speaking unprompted is opt-in.

**Explains itself.** Read-only introspection over its own source, a knowledge
base it can write to, document ingestion (PDF/DOCX), web search, and
read-only GitHub access to the repository it lives in.

**Is configured from a phone.** A mobile-first web dashboard on the same port
as everything else: settings, persona, memory inspection, logs, voice
controls, access levels mapped to the server's own Discord roles.

## What it costs to run

Every one of those capabilities except moderation costs money per use, and the
project is unusually explicit about which:

| Work | Provider | Metered as |
|---|---|---|
| Replies | OpenRouter | Per reply, standard or frontier rate |
| Memory, classification, de-escalation | OpenRouter (cheap utility model) | Per call — ~85% of all call volume |
| Voice transcription | OpenAI or Groq | Per minute of speech |
| Spoken replies | Fish Audio | Per minute of audio |
| Spoken replies (fallback) | edge-tts | Free |
| Moderation, automod, welcome, slash commands | — | Free |

That last row is load-bearing. It is what makes it safe to cut a customer's
AI off when they run out of credit: the server stays moderated.

## Who it is for

Three audiences, and the code treats them differently rather than pretending
they are the same:

**Self-hosters.** Clone it, set a Discord token and an OpenRouter key, run it.
No accounts, no credits, no metering — a guild that is not registered on the
platform is never billed and never gated, and there is no flag to remember to
set. This is the default path.

**Managed customers.** We hold the provider keys, meter what their bots use,
and bill it against a credit balance they top up. They never see a provider
invoice. When the balance hits zero the AI stops and the moderation keeps
running.

**Enterprise customers.** They hold their own provider contracts; the spend
sits on their accounts. We run the platform, the provisioning and the support.
Their usage is reported back at list price so they can reconcile it against
their own invoices, and never billed or gated by us.

Venue is a property of the *account*, not of a server, and mixing them on one
account is deliberately out of scope — the metering, the invoicing and the
failure modes all differ, and a per-server venue would mean answering what
happens when a managed server runs dry on an account that also has
bring-your-own-key servers.

## What is in the repository

```
nodebot/          The bot. Node 22, no framework, 31 test files.
  src/            Runtime: chat, voice, memory, pressure, moderation
  src/credits/    Rate card, ledger, metering, the zero-balance gate
  src/platform/   Accounts, orders, the provisioning pipeline
  src/backends/   Model catalog and rate-limit rerouting
  src/web/        Dashboard server and API
site/             Marketing pages, order form, customer dashboard, staff queue
docs/             Earlier deep-dives (some stale — see documents/README.md)
documents/        This set
bot/ web/ main.py The previous Python implementation. Not deployed.
```

The Python tree is history. The Node port superseded it, and `nixpacks.toml`
installs Python only because `node-gyp` needs it at build time — nothing runs
it. It is kept because the Python bot's tests and structure are still a useful
reference, not because it is live.

## The one architectural fact that shapes everything

**The bot is single-tenant: one process, one SQLite file, one Discord server.**

Everything about how the platform is built follows from that. The credit
ledger is correct for many bots on one account, but "many thousands of
tenants" is a different architecture — sharding the gateway connection, and
either a process per tenant or a multi-tenant gateway. That decision has not
been made, and it precedes any serious scale.

Today the platform tables and the bot share one database, which works while
the platform and the bots it bills are the same deployment. Splitting them
means the bot calling a credit service over HTTP, with a cached balance and
buffered usage events so a network blip does not silence anyone. That is a
known, understood piece of future work rather than a surprise waiting to
happen — see [04 — State of play](04-state-of-play.md).
