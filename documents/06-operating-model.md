# 06 — Operating model

*Descended from* Bot as a Service — Working Outline *v0.1, §4–5. The other half
of what is being sold: an operation that keeps running when any one of us is
unavailable.*

Almost nothing in this document is built. That is the point of writing it down
— the plumbing described here is what turns a working bot into a service
somebody can rely on, and none of it exists yet.

## 1. The partner circle

Decision on record: **informal crew, revenue share by contribution.** Trusted
people, handshake-level agreement.

"Informal" describes the legal structure, not the operational discipline. The
rules below are what make informality survivable — and they have to exist
*before* they are needed, because every one of them is a rule about what
happens when something goes wrong.

### 1.1 What a partner is

Someone who both does work — building, operating, intake, support — and shares
responsibility for the ecosystem staying up. Everyone contributes; there are no
pure passengers.

Contribution looks different per person:

- **Builder** — writes and configures bots, owns builds through delivery.
- **Operator** — hosting, monitoring, incident response, updates.
- **Front-of-house** — intake, customer comms, support, community.
- **Utility** — some of everything. In a small circle, most people.

Roles are hats, not job titles. One person wears several. **Every hat has at
least two people who can wear it.**

### 1.2 Joining

By invitation plus trial: a bounded piece of real work — one build, one
rotation shadow — before broad access. Day-one access is minimal and grows
with the work actually taken on.

Write down what a new partner is agreeing to. A pinned Discord message is
enough. Contribution expectations, how revenue share works, what happens if
they drift.

### 1.3 Work and money

- **Claiming.** Work items — builds, tickets, rotation weeks — get claimed
  openly in the partner channel. Claimed means accountable through completion
  or explicit handoff.
- **Contribution ledger.** A lightweight shared log of who did what. Not
  surveillance: it is the input to the split and the antidote to resentment.
- **Revenue share** by contribution over a period; monthly feels right early.
  Formula TBD — points per work type, hours-ish honour system, or flat with
  adjustment by consensus. **Pick something crude and fair over something
  precise and contentious.**
- **A cut for the commons.** 10–20% off the top for hosting, domains and
  tooling, before any split. The commons account is visible to every partner.

### 1.4 Redundancy — the actual point

The circle exists so the ecosystem has no single point of failure.

- **Two-person rule.** Every bot, every system, every customer relationship has
  a primary and a backup who could take over cold. No exceptions, including
  for founders.
- **Runbooks.** Every deployed bot gets one at delivery: what it does, where it
  runs, how to restart it, known quirks, customer contact norms. The intake
  spec is the seed. **Delivery is not done until the runbook exists.**
- **Watch rotation.** One partner per week is first responder to alerts and
  customer pings. Counts as contribution; goes in the ledger.
- **No personal accounts in the critical path.** Hosting, domains, tokens and
  repos live in org-owned accounts. A partner leaving should never be able to —
  or need to — take infrastructure with them.
- **Drift protocol.** If a partner goes quiet, their claimed work is reassigned
  openly after an agreed window (two weeks?), access is reviewed, and their
  share reflects the ledger. No drama required, because the rules existed
  before the situation did.

### 1.5 Risks, eyes open

- **Revenue-share disputes are the #1 killer of informal crews.** The ledger
  plus a crude-but-agreed formula is the mitigation. Revisit the formula on a
  schedule, not mid-argument.
- **No legal entity** means personal exposure and awkwardness signing anything.
  Fine at first. **Pick the formalisation trigger now** — e.g. $X/month for
  three straight months — so it is decided in advance rather than under
  pressure.
- **Payments will eventually need one named person's account.** That extra
  exposure should be acknowledged in the split.

  *Status: not yet exposed.* There is deliberately no payment processor —
  customers pay out of band and a partner issues credits by hand. Whoever's
  account eventually takes card payments is a decision still fully open.

## 2. What already exists

Being precise, because the gap between this section and the next is the work.

| | |
|---|---|
| **Org-owned GitHub** | Yes — `seed0001/discord-agent` |
| **Org-owned hosting** | Yes — Railway, deploying from `main` |
| **Bot template** | Yes, in the strongest sense: the bot *is* the template. Logging, config, error handling, restart-safety and 528 tests are already wired in. |
| **Access tiers** | Partly. The dashboard has creator/admin/moderator mapped to Discord roles; the platform has customer/staff. Nothing governs partner access to infrastructure. |
| **Deploy path any partner can execute** | Yes — merge to `main`. Documented in [03](03-running-it.md). |
| **Secrets manager** | No. Environment variables in Railway. |
| **Monitoring** | No. `/health` and a log buffer. |
| **Runbooks** | No. [03](03-running-it.md) is the closest thing and it covers one bot. |
| **Watch rotation** | No. |
| **Contribution ledger** | No. |
| **Backups** | **No.** See §4. |

The bot template line is worth dwelling on. §5.4 of the outline wanted "a
starter skeleton every new Discord bot begins from: logging, config handling,
error reporting, restart-safety already wired in." That exists — it is the
thing we have been building. Build quality and redundancy are baked in at the
template level rather than re-argued per project, exactly as intended.

## 3. Shared plumbing to build

In the order that removes the most risk per hour spent.

### 3.1 Backups — do this first

One SQLite file on one Railway volume holds customer accounts, order history
and the credit ledger. There is no copy.

The failure mode is no longer "we lose a day of chat." It is "we cannot prove
what anyone paid us." A nightly `sqlite3 .backup` to object storage is an
afternoon.

**Nothing else in this document matters as much.**

### 3.2 Monitoring and the watch rotation

Uptime and error alerting on every hosted bot, feeding one shared channel the
on-watch partner owns. The customer-visible half matters as much as the
technical half: even a "we noticed before you did" message builds enormous
trust, and it is the cheapest trust available.

Concrete first version: poll `/health` per bot, alert on two consecutive
failures, and alert on any `[credits] failed to meter` or repeated
`free-models-per-day` in the logs — see [03](03-running-it.md) for the symptom
table that should become the alert list.

### 3.3 Secrets

Today: environment variables in Railway. That is acceptable while one person
deploys and one bot runs. It stops being acceptable the moment a second
partner needs access to a customer's bot token, because the only way to grant
it is to grant everything.

This is also what blocks automatic provisioning: every managed bot's token is a
credential we hold, and it belongs in a secret manager with per-server
isolation, not next to the settings. Provisioning is a manual step *because*
this does not exist.

### 3.4 Per-bot isolation

One org-owned hosting account running all managed bots, containerised per bot
so one bad bot cannot take down the fleet.

Not yet a live problem — there is one deployment. It becomes one the moment
there are two customers, and the architecture note in
[01](01-the-project.md) applies: one process, one database, one server.

### 3.5 The contribution ledger

A shared document is enough to start. Builds delivered, rotation weeks served,
tickets handled, customers landed. The point is not precision; it is that the
input to the money conversation is written down before the money conversation
happens.

## 4. The honest summary

The **product** side is further along than the outline assumed — the bot,
credit metering, accounts, orders and a staff console all exist and have been
driven end to end.

The **operations** side is barely started. There is one deployment, one person
who knows how to fix it, no backups, no alerting, and no rotation. Right now
the ecosystem *is* a single point of failure, which is precisely the thing the
partner circle was conceived to prevent.

That asymmetry is the most useful thing in this document. The instinct will be
to keep building product, because product is more fun and more visible. The
next paying customer does not need another capability tier; they need the
confidence that their bot will be looked after by someone other than whoever
built it, and that if the database dies we can tell them what they paid.

## 5. Open questions

1. **Revenue-share formula** — points, hours, or flat-with-adjustment. Biggest
   social risk; decide early, revisit on a schedule.
2. **Formalisation trigger** — pick the number now, not under pressure.
3. **First circle roster** — who, and which hats does each want?
4. **Which hosting shape** — stay on Railway per-bot, or one VPS with
   containers? Cost versus convenience, and it interacts with §3.4.
5. **Who is the backup?** The two-person rule is the centrepiece of this
   document and currently has one person in it. *(New.)*
