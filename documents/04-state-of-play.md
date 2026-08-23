# 04 — State of play

What is real, what is not, and what will bite. Written to be believed without
reading the source, which means being blunt about the gaps.

## Built and working

**The bot, completely.** Text and voice, memory, pressure, moderation,
dashboard, knowledge base, document ingestion, GitHub read access,
introspection. This has been running for a real server, not just in tests.

**The credit system, end to end.** Pooled balance per account, metering on all
three provider chokepoints, the zero-balance gate, write-off tracking, daily
usage rollups. Verified by driving a real balance to zero and watching AI stop
while moderation kept running.

**The platform, end to end.** Sign-up, order form, staff queue, pipeline,
manual credit issuance, customer dashboard with live metered numbers. Driven
through a real browser: sign up → order → staff review → approve → attach a
Discord server → issue credits → spend them → run dry.

**Backend switching.** Hourly OpenRouter catalog, rate-limit parking, voice-
directed switching, automatic background rerouting.

**528 tests**, no network required.

## Not built — and these are not "nearly"

| | Status |
|---|---|
| **Card payment / checkout** | Nothing. Customers pay out of band; staff issue credits by hand against a reference. |
| **Automatic top-up** | The preference is stored and shown. Nothing fires. Charging a saved card off-session needs a processor. |
| **Automatic Discord app registration** | A person does it. No code mints tokens. |
| **Token custody** | No secret manager. This is why provisioning is manual. |
| **Enterprise key vault** | Key handover happens on a call. The dashboard says so rather than showing a box that does nothing. |
| **Backups** | None. See below. |
| **Monitoring / alerting** | None. `/health` and a log buffer. |
| **Password reset** | None. Fix it in the database. |
| **Rate limiting on sign-up / sign-in / orders** | None. |
| **ElevenLabs** | Priced on the rate card, marked `integrated: false`, not wired. |

## The three that matter most

### 1. No backups

One SQLite file on one Railway volume now holds customer accounts, order
history and the credit ledger. There is no copy anywhere.

The failure isn't "we lose a day of chat" any more; it is "we cannot prove what
anyone paid us." A nightly `sqlite3 .backup` to object storage is an afternoon
of work and should happen before the next customer, not the next ten.

### 2. Open endpoints with no rate limiting

`POST /api/platform/signup` and `POST /api/platform/orders` are both
unauthenticated by design — making someone sign up before they can tell you
what they want is how you lose the order. Fine for a known list of people;
an open spam target on a public domain.

Sign-in has no attempt limiting either. Passwords are scrypt with a per-account
salt and a 10-character minimum, so this is throttling, not a hole — but it is
the difference between a nuisance and an incident.

### 3. Single-tenant architecture

One process, one SQLite file, one Discord server. The ledger is correct for
many bots on one *account*, but many thousands of *tenants* is a different
architecture. Two specific limits:

- **Discord's per-team application cap.** One application per customer bot
  hits it early. Verify the actual cap before promising "your own bot" at
  scale; the fallback is a shared application with per-guild configuration,
  which changes the product story.
- **Splitting the platform from the bots.** Today they share a database, which
  works while they are the same deployment. Separating them means the bot
  calling a credit service over HTTP with a cached balance and buffered usage
  events, so a network blip does not silence anyone.

## Known unknowns

Three questions the code cannot answer, listed because guessing at them is how
a business gets a nasty surprise.

### Does the background rate cover its cost?

Background work is priced at **0.2 credits/call = $0.002**. That assumed the
free model pool, where our cost is zero and margin is 100%.

Backend switching now moves background work onto a *paid* model when the free
pool dries up — which is the correct behaviour and may well be underwater. A
memory consolidation call with a few thousand input tokens and a long output
can cost more than $0.002 on a paid model.

This is measurable, not a guess: every usage event stores real
`prompt_tokens` and `completion_tokens` alongside the frozen price, precisely
so margin can be checked against a provider invoice. There is no data yet.
**Worth twenty minutes after a day of real traffic.**

### What do the other rates actually earn?

Rough margins at list price:

| Line | Charged | Our cost | Margin |
|---|---|---|---|
| Transcription | $0.06/min | $0.006/min (OpenAI) | ~90% |
| Transcription | $0.06/min | $0.00067/min (Groq) | ~99% |
| Reply, standard | $0.02 | Model-dependent | Healthy |
| Reply, frontier | $0.08 | Model-dependent | Thinner |
| Background | $0.002 | $0 free / unknown paid | **Unknown** |

The transcription line is the strongest and the cheapest to improve — moving
to Groq is three environment variables.

### Who is actually buying?

Zero customers so far. Everything about tiering and pricing is a hypothesis.
The order form logs every submission, so the first ~10–20 intakes are the
market research — see [05 — Service model](05-service-model.md), which makes
the same point.

## Roadmap

Ordered by what unblocks or protects the most, not by size.

**Before the next paying customer**
1. **Backups.** Nightly SQLite snapshot off the volume.
2. **Rate limiting** on sign-up, sign-in and order submission.
3. **Daily-aware background breaker.** The hourly cap is tuned to the wrong
   axis; switching routes around it but does not fix the pacing.

**Soon after**
4. **Switch transcription to Groq.** Cheaper, faster, more accurate.
5. **Measure background margin** against a real provider invoice, then reprice
   the 0.2 line or pin background to a specific cheap model.
6. **Password reset**, before anyone outside the room has an account.
7. **Monitoring**: uptime and error alerting into one channel.

**Product**
8. **Payment processing.** The ledger is already idempotent on a
   caller-supplied grant id, which is exactly what a webhook needs — wiring a
   processor means adding a `source` that calls the same `issue()`.
9. **Automatic provisioning**, which needs token custody first.
10. **Memory relevance retrieval.** Durable memory only grows; fix retrieval
    before the size cap forces lossier consolidation.

**Architecture, when volume demands it**
11. Split the platform from the bots (cached balance + buffered usage).
12. Answer the Discord application cap question before it answers itself.

## The pre-existing roadmap

`docs/how-max-thinks.md` §11 has its own list, written before any of the
platform work. Three items are still open and still right:

- Pin classification to one verified-reliable model instead of a rotating free
  pool. (Backend switching helps; it does not settle it.)
- Give memory a relevance step. (Item 10 above.)
- Integration tests around the two real pipelines — message → classification →
  gate → spoken reply, and utterance → transcription → wake response.

Two are done: collapsing the Python/Node split, and recognising rate limits
rather than dropping the reply.
