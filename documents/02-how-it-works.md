# 02 — How it works

Architecture as built. For the reasoning behind the conversational design in
much more depth, `docs/how-max-thinks.md` is still the best source and nothing
here replaces it.

## Runtime

One Node 22 process. No framework — the HTTP API is 55 small routes on
`node:http`, and pulling in Express would add a dependency tree for a router
and a body parser, both of which are a few lines here.

Storage is SQLite through `node:sqlite`, which is genuinely synchronous. That
is the normal, correct way to use embedded SQLite: there is no real async I/O
happening, and the most popular userland alternative is sync-only for the same
reason. So the database functions are not `async`, unlike their Python
predecessors.

Discord IDs are stored as **TEXT, not INTEGER**. Snowflakes routinely exceed
`Number.MAX_SAFE_INTEGER`, and any id past 2^53 comes back from SQLite as a
rounded float. The Python implementation stored them as INTEGER, so the two
schemas are not interchangeable despite sharing table names — `initDb` detects
a Python database and refuses to start rather than silently keying warnings and
memory to the wrong user.

## The two pipelines

Everything the bot does flows through one of two paths.

### Text

```
message → automod ──────────────────────────────► (delete, log)
        → mention? ──► credit gate ──► model+tools ──► reply
        → pressure observation ─────────────────► (may interject later)
```

All three run independently for every message. Automod deleting a message does
not stop the AI from having already seen it, and pressure observes everything
including the bot's own messages.

### Voice

```
speaker → noise gate → transcribe → wake/mention detection
                                  → credit gate → model+tools → TTS → playback
```

The noise gate drops utterances under 1.5 seconds or quieter than an RMS
threshold before they reach transcription — silence and background noise
would otherwise be transcribed, billed, and occasionally hallucinated into
words by Whisper.

Both pipelines write into the same conversation buffer and the same memory.

## Memory

Two tiers, both per-guild and both surviving restarts.

**Working memory** is the current conversation. **Durable memory** is
long-term facts and preferences. Consolidation folds new turns into both,
running on the cheap utility model rather than the conversational one.

Two properties worth knowing:

- **Raw turns are persisted immediately**, before consolidation runs, and kept.
  A redeploy landing mid-consolidation replays the unconsolidated turns on
  restart instead of losing them.
- **Every turn is tagged with its source and channel.** That is what makes
  cross-surface recall work rather than being a claim.

Durable memory only grows, and retrieval currently dumps the whole file into
every prompt. Fixing that — a relevance step — is on the roadmap ahead of
being forced into more aggressive, lossier consolidation by the size cap.

## The pressure engine

Six reservoirs that charge on observed signals and decay on a timer
independent of message traffic. Crossing a threshold produces a *candidate*,
which then has to survive a gate: cooldowns, repetition checks, relevance to
the current topic, and a check on whether the room is already heated.

It is off by default per guild. The engine has its own tests and its own
README under `nodebot/src/pressure/`.

## Persona: two halves

The system prompt is split into *who it is* and *what it can do*, edited
separately on the dashboard. A guild that never customises one keeps getting
the current text from `persona.js`, so neither half can be lost to a fresh
database and the capability half stays true as features land.

This is enforced, not merely intended. `test/systemPrompt.test.js` fails if the
capability prompt names a tool that does not exist — a direct response to the
Python version advertising `sandbox_*` tools and eight slash commands the bot
never had.

## Credits

One credit is one cent of list price. Customers only ever see credits.

### How credit reaches a bot

```
accounts  ──1:N──▶  platform_servers  ──1:1──▶  a Discord guild
   │
   └── credits_milli   ONE pooled balance, shared by every bot
```

A bot bills by looking up its own guild id, following that to the account, and
drawing on the pooled balance. Two consequences:

- **A guild with no row bills to nobody.** Never metered, never gated — which
  is exactly what a self-hosted install and an enterprise customer both want,
  with no flag to set. Absence from the table *is* the answer.
- **The balance is pooled, not allocated.** Nobody has one bot go silent while
  another sits on unused credit. Per-bot spend is still recoverable because
  every usage event records its server id.

Attaching a guild is therefore the last provisioning step and the moment
billing starts. `guild_id` is UNIQUE — two bots cannot claim the same guild,
or "which account does this bill?" has two answers.

### Integer millicredits

Internally every amount is an integer count of thousandths of a credit.

This is not fastidiousness. Background work is **0.2 credits per call** and,
by the rate card's own note, ~85% of all call volume. Deducting 0.2 from an
integer balance truncates to zero, which would make the large majority of what
we actually spend money on free. A float balance would drift over the hundreds
of thousands of small writes this is built to take.

### Where metering happens

Three chokepoints cover every billable call, and each meters *after* the
provider returns, from real counts:

- **`chat()`** bills one reply per call, not per HTTP round trip. A tool loop
  or a junk re-roll can take several round trips to produce the one answer the
  customer receives, and the rate card sells "per reply". Real token counts
  ride along on the usage event so margin can be checked later.
- **`transcribePcm()`** bills per minute, and only when the utterance produced
  real text. Silence, noise blips and hallucinated filler bill nothing, so a
  noisy room cannot drain a balance.
- **Fish TTS** bills per minute read out of the returned MP3's own frame
  header. Unreadable audio bills **zero** rather than a guess, so a format
  change upstream shows up as revenue going missing rather than as customers
  charged against an invented number.

### The gate

Order of operations per AI call: read balance → refuse if ≤ 0 → make the call
→ write a usage event and decrement, in one transaction.

Because metering follows the call, **a call can complete that takes the balance
under**. The balance is a gate on *starting* work, not a ceiling on finishing
it; overshooting by one call is much cheaper than pre-authorising every
request. The balance floors at zero and the shortfall is written off, but both
numbers are kept so the write-off is a summable figure rather than revenue
quietly evaporating.

Two deliberate properties:

- **The gate fails open.** If the ledger itself is broken the bot keeps
  answering and shouts in the log. A database problem on our side silencing
  every customer's bot at once is far worse than some unbilled replies.
- **Moderation never touches the gate.** Automod, welcome and the slash
  commands do not call a paid provider at all — a stronger guarantee than
  gating them correctly, and `test/credits.test.js` fails if an import ever
  makes one of them reach a billable provider.

## Backend switching

The conversational and background models are configured separately and fail
differently.

**Conversational** — somebody is waiting. On a 429 the bot says which backend
is down and offers three alternatives with what each costs, then switches when
told to. By voice: "B", "the second one", "switch to Haiku", "switch back",
"never mind".

**Background** — memory, classification, de-escalation. Reroutes itself and
logs it. Nobody is around at 3am, and the alternative is memory consolidation
quietly stopping for the day.

The candidate list comes from OpenRouter's model catalog, refreshed hourly and
cached in SQLite so a restart or an OpenRouter outage still leaves
alternatives at the moment they are needed. A model that returns 429 is parked
rather than dropped: fifteen minutes for a burst limit, six hours for a daily
free-model quota, read out of the provider's own message.

**The answer matching uses no model at all.** This whole path fires when the
model backend is unavailable, so anything needing a model to interpret "switch
to B" would be broken exactly when it is needed. That is also why the options
are lettered — single letters survive a bad transcription; model ids do not.
An utterance that is not an answer falls through to normal handling, so
someone who ignores the offer and keeps talking does not lose their sentence.

The shortlist spans tiers on purpose — one free, one cheap, one steady-vendor.
Three free models are three models that hit the same daily quota on the same
day, which is the failure being routed around.

## The platform

```
accounts            id, name, email, password_hash, venue, credits_milli, is_staff
platform_servers    account_id, request_id (UNIQUE), guild_id (UNIQUE), tier, modules, status
platform_requests   the order form submission + pipeline stage
usage_events        append-only; kind, quantity, credits_milli (frozen), charged_milli
credit_grants       id (idempotency key), credits, source, reference, issued_by
model_catalog       OpenRouter's model list, refreshed hourly
```

`usage_events.credits_milli` is frozen at write time. Rates change; a
customer's past invoice must not.

### The provisioning pipeline

```
submitted → validated → review → provisioning → ready
   auto       auto       HUMAN     HUMAN         HUMAN
```

An order that fails validation stops at `submitted` **and is still kept**,
with its problems attached — somebody who mis-picked a capability set is the
customer most worth talking to, and throwing the form away to show them a red
box loses the lead with it.

Everything from `review` on is moved by a person. That is honest about two
things at once: no code here registers a Discord application or mints a token,
and this is a supported service where someone sits down with the customer.
`STAGES` carries an `auto` flag, so when provisioning really is automated the
honesty is a one-line change.

Approving is idempotent, enforced by a unique index rather than a check — two
concurrent clicks cannot both find nothing and both insert.

### Two kinds of session

Platform sessions are **not** dashboard sessions, and neither stands in for the
other. A dashboard cookie says what someone may do to a Discord server,
derived from that server's own roles. A platform cookie says which customer
they are. For the same bot those are frequently different people.

Staff-ness is recomputed on every request rather than read from the token, so
revoking it takes effect immediately. `PLATFORM_STAFF_EMAILS` solves the
bootstrap — the first staff account cannot be promoted by an existing one.

## Web surface

One port serves everything:

| Path | What |
|---|---|
| `/` | Discord dashboard (owner/admin/moderator, Discord-role derived) |
| `/api/*` | Dashboard API |
| `/api/platform/*` | Customer + staff API |
| `/site/` | Marketing pages, order form, customer dashboard, staff console |
| `/health` | Liveness |

Routes are auth-protected unless explicitly marked open, and a route that
forgets to declare a level is treated as creator-only — new routes fail closed
rather than open.
