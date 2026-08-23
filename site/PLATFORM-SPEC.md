# Platform — onboarding, credits, provisioning

How a customer gets a bot, how they pay for it, and what happens when they
stop.

Most of this is built. Each section says what is real and what is not, and
"not built" here means *not built*, not "nearly". The parts that involve
taking money automatically or registering Discord applications automatically
are the parts that are not.

| | Built | Where |
|---|---|---|
| Credit ledger, metering, the zero-balance gate | ✅ | `nodebot/src/credits/` |
| Customer accounts and sign-in | ✅ | `nodebot/src/platform/accounts.js` |
| Order form → queue → bot | ✅ | `nodebot/src/platform/orders.js` |
| Manual credit issuance | ✅ | staff API + `admin.html` |
| Card payment / checkout | ❌ | out of band, by hand |
| Automatic top-up | ❌ | preference is stored, nothing fires |
| Automatic Discord app registration | ❌ | a person does it |
| Enterprise key custody | ❌ | handled on the call |

## Two service venues

| | Managed | Enterprise |
|---|---|---|
| Provider accounts | Ours | Theirs |
| Who pays the provider | Us | Them |
| Customer pays us | Tier subscription + usage credits | Flat platform fee per server |
| Provisioning | Never automatic — we build it with them | Never automatic — key handover first |
| Failure mode when out of credit | Bot stops replying | N/A (their provider bill) |

Both are supported services. Neither is "here's your bot, good luck": someone
sits down with the customer and builds it out with them, and that is the
product rather than a stage we intend to automate away.

The venue is a property of the **account**, not the server. Mixing them on one
account is out of scope: the metering, the invoicing and the failure modes all
differ, and a per-server venue would mean answering "what happens when a
managed server runs dry on an account that also has BYOK servers".

## How credit reaches a bot

```
accounts  ──1:N──▶  platform_servers  ──1:1──▶  a Discord guild
   │
   └── credits_milli   ONE pooled balance, shared by every bot
```

A bot bills by looking up its own guild id in `platform_servers`, following
that to the account, and drawing on the pooled balance. Two consequences:

- **A guild with no row bills to nobody.** It is never metered and never
  gated — which is what a self-hosted install and an enterprise customer both
  want, with no flag to remember to set. This is why the change is invisible
  to any deployment not running on the platform.
- **The balance is pooled, not allocated per bot.** Nobody has one bot go
  silent while another sits on unused credit. Per-bot spend is still
  recoverable — every usage event records its `server_id` — so the reporting
  works without the rationing.

Attaching a guild is therefore the last provisioning step, and the moment
billing starts. `guild_id` is UNIQUE: two bots cannot claim the same guild, or
"which account does this bill?" would have two answers.

## Money is integer millicredits

One credit is one cent of list price, and the customer only ever sees credits.
Internally everything is an integer count of thousandths of a credit.

This is not fastidiousness. Background work is **0.2 credits per call** and, by
the rate card's own note, ~85% of all call volume. Deducting 0.2 from an
integer balance truncates to zero, which would make the large majority of what
we actually spend money on free. A float balance would drift over the hundreds
of thousands of small writes this is built to take.

## Data model

```
accounts
  id, name, email, password_hash, venue: 'managed'|'enterprise'
  credits_milli        integer, pooled. Floors at zero — see Metering.
  auto_topup           {enabled, threshold, packId} — recorded, not acted on
  is_staff

platform_servers
  id, account_id, request_id (UNIQUE), guild_id (UNIQUE)
  name, bot_name, tier, modules[]
  status: 'provisioning'|'ready'|'suspended', provisioned_at

platform_requests      the order form submission
  id, account_id, venue, account_name, email
  server_name, bot_name, tier, modules[]
  details              accent, persona, wake phrases, voice, key status, notes
  stage, notes, submitted_at

usage_events           append-only, one row per billable action
  id, account_id, server_id, guild_id, at
  kind                 a rate-card id: 'reply-standard' | 'background' | …
  quantity             replies, calls, or minutes
  credits_milli        quantity × rate at time of use, FROZEN
  charged_milli        what the balance actually lost
  provider_ref         for reconciliation against the provider invoice

credit_grants
  id                   idempotency key
  account_id, credits_milli, pack_id, amount_cents
  source, reference, issued_by, note
```

`usage_events.credits_milli` is frozen at write time on purpose. Rates change;
a customer's past invoice must not.

`charged_milli` exists because the two numbers genuinely differ — see below.

## Provisioning pipeline

```
submitted → validated → review → provisioning → ready
   auto        auto      HUMAN      HUMAN        HUMAN
```

- **submitted** — order persisted. An order that fails validation stops here
  *and is still kept*, with its problems attached: somebody who mis-picked a
  capability set is the customer most worth talking to, and throwing the form
  away to show them a red box loses the lead with it.
- **validated** — capability set checked against the tier, and against
  dependencies (`wake` without `voice-join` is affordable at that tier and
  meaningless). Runs synchronously so the customer sees it immediately.
- **review** — we get in a room with them and build it out. Enterprise key
  handover happens here and this stage is **never** skipped: we do not
  provision against keys we did not receive.
- **provisioning** — register the Discord application, mint the token, write
  the settings. Done by a person today.
- **ready** — invite issued, dashboard access granted. Marking a bot ready
  carries its order here too.

The pipeline only ever moves forward, one stage at a time. Skipping is refused
rather than warned about, because of what gets skipped. Rejection is terminal
and outside the ladder.

Approving is **idempotent on the order id**, enforced by a unique index rather
than a check — two concurrent clicks cannot both find nothing and both insert.

## Metering

Rates live in `nodebot/src/credits/rates.js` and are list price inclusive of
margin. A customer is never shown a raw provider price. `site/js/platform.js`
holds a copy for the marketing pages; a test fails if the two disagree.

Metering happens **after** the provider call returns, from the real token or
duration count — never estimated up front. Concretely:

- `chat()` bills **one reply per call**, not per HTTP round trip. A tool loop
  or a junk re-roll can take several round trips to produce the one answer the
  customer receives, and the rate card sells "per reply". Real token counts
  ride along on the usage event, which is what would catch that assumption
  going bad for an unusually expensive tool loop.
- `transcribePcm()` bills per minute of audio, and **only when the utterance
  produced real text**. Silence, noise blips and Whisper's hallucinated filler
  bill nothing, so a room full of background noise cannot drain a balance. We
  paid the provider for those; that sits in our margin, deliberately.
- Fish TTS bills per minute read out of the returned MP3's own frame header.
  Unreadable audio bills **zero** rather than a guess, so a format change
  upstream shows up as revenue going missing rather than as customers charged
  against an invented number.
- edge-tts bills nothing. A bot out of Fish quota degrades to a lesser voice,
  not to silence.

Order of operations per AI call:

1. Read balance. If ≤ 0, refuse and post the "out of credits" notice — at most
   once per hour per guild, or a dead balance turns the bot into a spammer.
2. Make the provider call.
3. Write a `usage_event` and decrement the balance in one transaction.

Because step 3 follows step 2, **a call can complete that takes the balance
under**. The balance is a gate on *starting* work, not a ceiling on finishing
it; overshooting by one call is much cheaper than pre-authorising every
request. The balance floors at zero and the shortfall is written off — the
customer never carries a debt to us — but both numbers are kept, so the
write-off is a summable figure on the dashboard rather than revenue quietly
evaporating.

**The gate fails open.** If the ledger itself is broken the bot keeps
answering and shouts in the log. A database problem on our side silencing
every customer's bot at once is a far worse outcome than some unbilled
replies.

**Moderation, automod, welcome and the slash commands never touch the gate.**
They cost nothing to run and they are what stops a lapsed account becoming an
unmoderated server.

Enterprise usage is recorded at list price with `charged_milli = 0`: reported
back so they can compare against their own provider invoices, never billed.

## Paying us

There is no card processing. The customer pays however we agreed and a member
of staff issues the credits against that payment reference.

A reference is **required**. An issued credit with nothing behind it is
indistinguishable from an accident or a favour, and the one question this
ledger has to survive is "why does this account have credit".

Issuing is idempotent on a caller-supplied grant id — that is what makes a
double-clicked button safe, and it is the same property a payment webhook will
need if one ever lands. Wiring a processor in means adding a `source` that
calls the same `ledger.issue()`; nothing downstream changes.

## API surface

```
GET    /api/platform/catalog             tiers, capabilities, rates, packs   public
POST   /api/platform/signup                                                  public
POST   /api/platform/signin | signout                                        public
POST   /api/platform/orders              submit an order                     public
POST   /api/platform/orders/validate     check a capability set              public

GET    /api/platform/me                  account + bots + balance
GET    /api/platform/usage?days=30       daily rollups, by kind, by bot
GET    /api/platform/grants              credit history
GET    /api/platform/orders              your own orders
PUT    /api/platform/autotopup

# staff only
GET    /api/platform/admin/requests
PUT    /api/platform/admin/requests/:id            edit capabilities, tier, notes
POST   /api/platform/admin/requests/:id/advance
POST   /api/platform/admin/requests/:id/approve
GET    /api/platform/admin/accounts
GET    /api/platform/admin/accounts/:id
POST   /api/platform/admin/accounts/:id/credits    issue credit
POST   /api/platform/admin/servers/:id/guild       attach a Discord server
POST   /api/platform/admin/servers/:id/status
```

Submitting an order is public on purpose: making somebody sign up before they
can tell you what they want is how you lose the order. If they are signed in
it attaches to them; if not, the email on the form is how it gets matched up.

`/usage` returns pre-aggregated daily rollups, not raw events. A busy server
generates thousands of events a day and the chart wants thirty numbers.

**Platform sessions are not dashboard sessions.** A dashboard cookie says what
someone may do to a Discord server, derived from that server's roles; a
platform cookie says which customer they are. Neither stands in for the other,
because for the same bot they are frequently different people.

Staff-ness is recomputed on every request rather than read from the token, so
revoking it takes effect immediately. `PLATFORM_STAFF_EMAILS` solves the
bootstrap — the first staff account cannot be promoted by an existing one —
and is the way back in when the database is what you cannot reach.

## Things that will bite

- **Discord application limits.** One application per customer bot means
  hitting Discord's per-team application cap early. Verify the cap before
  promising "your own bot" at scale; the fallback is a shared application with
  per-guild configuration, which changes the product story.
- **Token custody.** Every managed bot's token is a credential we hold. It
  belongs in a secret manager with per-server isolation, not in the same
  SQLite file as the settings. Nothing stores tokens today — that is why
  provisioning is a person.
- **Tenancy.** The bot is one process, one SQLite file, one server. The ledger
  is correct for many bots on one account, but many thousands of tenants is a
  different architecture — sharding the gateway connection, and either a
  process per tenant or a multi-tenant gateway. Today the platform tables and
  the bot share a database, which works while the platform and the bots it
  bills are the same deployment. Splitting them means the bot calling a credit
  service over HTTP, with a cached balance and buffered usage events so a
  network blip does not silence anyone.
- **Credit fraud.** Less pressing without a card path — every credit today is
  issued by a person against a payment they saw clear. It comes straight back
  the moment checkout lands: rate-limit new accounts and hold the first
  purchase.
- **Passwords.** scrypt with a per-account salt, and a minimum length. No
  rate limiting on sign-in yet, and no password reset — both are needed before
  this faces the open internet rather than a list of people we know.
