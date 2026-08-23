# 05 — Service model

*Descended from* Bot as a Service — Working Outline *v0.1. Still a working
document: arguable by design. What has changed is that some of it is now
running code, so this version marks the line between what we decided and what
we built.*

## 1. The idea

We build, configure, host and maintain bots — starting with Discord — for
customers at any technical level. The customer says what they want and how
involved they want to be; intake works out the rest.

Two things are being sold. To customers: *the bot you want, at the involvement
level you want.* To ourselves: *an operation that keeps running when any one
of us is unavailable.* The second is [06 — Operating model](06-operating-model.md).

## 2. Discord first, doors open

Discord is the wedge, not the ceiling. It has the lowest-friction demo in
existence — an invite link and instant gratification — and demand spread
across wildly different sophistication levels, which is exactly the spread a
tiered model is built for. The same intake, hosting and partner model carries
to Telegram, Slack, Twitch and web automation.

Concretely, "doors open" means:

- The storefront talks about **bots and automations**, not "Discord bots".
- Intake's first question is platform-agnostic: *where does this need to live?*
- Internal tooling is platform-neutral from day one, so bot #40 on a new
  platform reuses bot #1's plumbing.

## 3. The ladder — and the thing v0.1 got tangled

The core product decision stands: **we don't sell one service, we sell
altitude.** But building the platform surfaced something the outline missed.

**There are three independent axes, not one.**

| Axis | Question it answers | Where it lives |
|---|---|---|
| **Involvement** | How much does the customer want to touch? | The ladder below |
| **Capability** | What does the bot actually do? | Built: Hobby / Core / Voice / Autonomy |
| **Venue** | Whose provider keys, whose bill? | Built: managed / enterprise |

The outline's four tiers conflate all three. A customer who wants to be hands-
off (involvement 1) might still want the pressure engine (capability:
Autonomy), and might still be an enterprise with its own OpenAI contract
(venue: enterprise). Those are three separate answers, and the intake should
collect them separately.

### 3.1 Involvement — the ladder

| Rung | Nickname | Customer does | We do | Pricing shape |
|---|---|---|---|---|
| 1 | **Just make it work** | Describes it in plain language. Never sees code. | Everything. | Subscription + usage |
| 2 | **Hands on the dials** | Adjusts settings on the dashboard. No code. | Build, host, maintain; expose a safe surface. | Subscription + usage |
| 3 | **Co-pilot** | Comfortable in an editor; wants to own or extend the code. | Scaffold, review, optionally host, be the safety net. | Project fee + retainer |
| 4 | **Rescue & retainer** | Already has a half-built or broken bot. | Finish it, fix it, adopt it if they want. | Diagnostic + project + retainer |

Rung 4 may be the best lead generator: semi-technical tinkerers who hit a wall
are already motivated and already understand the value of someone who finishes
things. Recurring revenue from rungs 1–2 and retainers on 3–4 is what funds an
on-call rotation. One-off projects do not.

### 3.2 What the platform actually encodes

Being precise about the gap, because it is where the next build decisions are:

- **Rungs 1 and 2 are the same product.** Both are the managed venue; both get
  the dashboard. The only difference is whether we walked them through it. That
  is an onboarding distinction, not a pricing tier — and pricing them
  differently is hard to defend when the software is identical. **Recommend
  merging them** and letting the dashboard be a feature everyone has.
- **Rung 3 is roughly the enterprise venue.** Own keys, own spend, we run the
  platform. The fit is not exact: enterprise is defined by *whose provider bill
  it is*, not by whether they write code.
- **Rung 4 has no representation at all.** Rescue is a services engagement, not
  a product tier. It does not need one — but it does need somewhere to record
  the customer, and today the order form assumes a new bot.

### 3.3 Capability tiers (built)

| Tier | Price | The line |
|---|---|---|
| Hobby | $0 | Full moderation stack |
| Core | $19 | Persistent memory, persona, tools, full model catalog |
| Voice | $49 | Joins voice, per-speaker transcription, wake phrases, TTS |
| Autonomy | $99 | The pressure engine — it speaks up first |

An order picks a tier and a set of capabilities, and the tier is validated
against them synchronously — impossible combinations come back immediately
rather than on the call two days later.

⚠️ **The tier limits in the marketing copy are not enforced anywhere.** "300 AI
replies" on the Hobby tier is invented text. A tier controls which capabilities
an order may switch on; **credits** are what actually meter usage. Either
enforce the limits or stop printing them.

## 4. How money actually works

The outline said "monthly subscription" and left it there. What is built:

**Managed** — subscription tier plus **usage credits**. One credit is one cent
of list price. The customer tops up a balance; every reply, background call,
transcribed minute and spoken minute draws it down. At zero, AI stops and
moderation keeps running.

**Enterprise** — flat platform fee per server. Their provider bill is their
own. Usage is reported at our list price so they can reconcile it, and never
charged by us.

**There is no card processing.** Customers pay however we agreed and a partner
issues the credits against a payment reference, which is required — an issued
credit with nothing behind it is indistinguishable from an accident, and the
one question a ledger has to survive is *why does this account have credit.*

That is a smaller compromise than it sounds, and it has one real upside worth
noting against §4.5 of the outline: **the "payments need one named person's
Stripe account early" exposure does not exist yet.** Nobody is personally
carrying a payment processor. When that changes it is a deliberate decision,
not something that happened because it was the only way to take money.

Issuance is idempotent on a caller-supplied id — which is exactly the property
a payment webhook needs, so wiring a processor later means adding a `source`
that calls the same function.

## 5. Intake

Intake's real job is triage. Requirements gathering is the visible half;
**knowledge-level assessment is the hidden half.** Both come out of one
conversation.

### 5.1 The flow

1. **Front door** — the site, or our own Discord server where an intake bot
   runs the first pass. The intake bot *is* a live demo of the work.
2. **Discovery** — what should it do (free text; how they describe it tells
   you a lot on its own), what community, what size, what they use now,
   timeline, budget.
3. **Altitude** — asked casually, never as a quiz. *Do you run or host
   anything yourself? If it needed a settings tweak, would you rather click a
   dashboard, edit a config file, or message us? Ever worked with code, even a
   little? Do you want to own this long-term or never think about it again?*
4. **Assignment** — map answers to all three axes, and confirm in the
   customer's own language: "sounds like you want this fully handled." Never a
   label they feel graded by.
5. **Scope + quote** — a one-page spec: what it does, what service level, what
   it costs, what "done" and "supported" mean.
6. **Handoff** — a partner claims the customer and the spec becomes the build
   ticket.

### 5.2 Principles

- **Never make anyone feel dumb; never make anyone feel slowed down.** The
  no-code customer and the VS Code customer should each feel the process was
  built for them.
- **Watch what they do, not what they say.** Someone who answers the free-text
  question in pseudo-code just told you their rung. Someone who says "I'm
  technical" but has never hosted anything belongs one rung below where they
  put themselves.
- **Every intake is market research.** Log tier, request type, source and
  outcome. Revisit positioning after the first 10–20. We have zero customers;
  everything about the tiering is a hypothesis.
- **Intake produces an artifact.** The one-page spec is contract-lite, build
  ticket, and runbook seed. No intake ends in vibes only.

### 5.3 What changed since v0.1

The outline asked whether to build the intake bot as project #1. **The web
order form and staff queue already exist**, so that question is now smaller
than it was: the pipeline runs today at `/site/build.html` → staff console.

That reframes the intake bot from prerequisite to complement — it is the
Discord-native front door and the demo, and it can feed the same
`POST /api/platform/orders` endpoint the form uses. Still worth building.
No longer blocking.

Two things the built form does that are worth keeping in any intake:

- **No account required to submit.** Making somebody sign up before they can
  say what they want is how you lose the order.
- **An order that fails validation is still recorded**, with its problems
  attached. Somebody who mis-picked is the customer most worth talking to;
  throwing the form away to show them a red box loses the lead with it.

## 6. Customer journey

1. Finds us — referral, our Discord, marketplace listings, rescue search.
2. Intake → three axes diagnosed → one-page spec.
3. Partner claims them; quote accepted.
4. Build → deploy → **runbook written** (delivery is not done without it).
5. Onboarded at their altitude: dashboard walkthrough, repo handoff, or
   nothing at all.
6. Ongoing: monitoring and watch rotation cover them; support routes to the
   on-watch partner; upsells flow back through a mini-intake.

Steps 4–6 depend on plumbing that does not exist yet. See
[06 — Operating model](06-operating-model.md) §3.

## 7. Open questions

Carried from v0.1, updated.

1. **Merge rungs 1 and 2?** They are the same software. *(New — the strongest
   candidate for a decision this week.)*
2. **Pricing numbers.** The capability tiers have prices; the involvement
   rungs do not. What is a rescue diagnostic worth? Needs a market scan.
3. **Enforce or delete the tier limits.** "300 AI replies" is currently
   fiction. *(New.)*
4. **Where does rescue live?** No product representation, and the order form
   assumes a new bot. *(New.)*
5. **Does the background rate cover its cost?** Priced assuming a free model
   pool that we now route off automatically. Measurable — see
   [04 — State of play](04-state-of-play.md). *(New, and it is a real number,
   not a philosophical question.)*
6. **Name and storefront** — naming, landing page, and whether our own Discord
   server is the primary front door.
7. **First circle roster** — see [06](06-operating-model.md).
