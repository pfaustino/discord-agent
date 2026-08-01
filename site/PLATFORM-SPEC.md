# Platform spec — onboarding, credits, provisioning

What the front-end in `site/` expects the backend to provide. Every screen
reads and writes through `js/platform.js`'s `Store`, so making this real means
replacing that one module with `fetch` calls — no screen touches storage
directly.

Nothing here is built. This is the contract the demo was written against.

## Two service venues

| | Managed | Enterprise |
|---|---|---|
| Provider accounts | Ours | Theirs |
| Who pays the provider | Us | Them |
| Customer pays us | Tier subscription + usage credits | Flat platform fee per server |
| Provisioning | Automatic after review | Never automatic — key handover first |
| Failure mode when out of credit | Bot stops replying | N/A (their provider bill) |

The venue is a property of the **account**, not the server. Mixing them on one
account is out of scope: the metering, the invoicing and the failure modes all
differ, and a per-server venue would mean answering "what happens when a
managed server runs dry on an account that also has BYOK servers".

## Data model

```
Account
  id, name, email, venue: 'managed'|'enterprise'
  tier                 highest tier across its servers (display only)
  credits              integer, managed only. Never negative — see Metering.
  autoTopUp { enabled, threshold, packId }
  keys { openrouter, transcription, fish }   enterprise only, status not value
  stripeCustomerId, createdAt

Server
  id, accountId, requestId
  guildId              null until the bot is actually invited
  name, botName, accent, members, status: 'provisioning'|'ready'|'suspended'
  tier, modules[]      the authoritative capability set for this bot
  discordAppId, tokenRef      tokenRef points at the secret store, never the token
  creditsThisPeriod, provisionedAt

Request                the onboarding submission
  id, accountId, venue
  accountName, email, serverName, botName, accent
  tier, modules[], wake[], voiceModel, followupSec, persona
  packId               managed only
  keys { openrouter, transcription, fish }   enterprise only, 'supplied'|'pending'|'not-supplied'
  stage, submittedAt, notes

UsageEvent             append-only, one row per billable action
  id, accountId, serverId, at
  kind                 matches a rate-card id: 'reply-standard' | 'background' | …
  quantity             replies, calls, or seconds
  credits              quantity × rate at time of use, frozen
  providerRequestId    for reconciliation against the provider invoice
```

`UsageEvent.credits` is frozen at write time on purpose. Rates change; a
customer's past invoice must not.

## Provisioning pipeline

```
submitted → validated → review → provisioning → ready
   auto        auto      HUMAN       auto        auto
```

- **submitted** — request persisted, nothing else.
- **validated** — module set checked against the tier; impossible combinations
  rejected. Runs synchronously so the customer sees the result immediately.
- **review** — a person confirms what gets switched on. Enterprise key handover
  happens here and this stage is **never** skipped for enterprise: we do not
  provision against keys we did not receive.
- **provisioning** — register the Discord application, mint the token, allocate
  the database and volume, write the settings rows.
- **ready** — issue the invite link and grant dashboard access.

Approving from the admin queue must be idempotent. A double-click cannot mint
two Discord applications, so `provisioning` needs a uniqueness key on
`requestId`.

## Metering

Rates live in `CREDIT_RATES` (`js/platform.js`) and are list price inclusive of
margin. A customer is never shown a raw provider price.

Metering happens **after** the provider call returns, from the real token or
duration count — never estimated up front. That means a call can complete with
a zero or negative balance; the balance is a gate on *starting* work, not a
hard ceiling on it. Overshoot by one call is acceptable and much cheaper than
the alternative of pre-authorising every request.

Order of operations per AI call:

1. Read balance. If ≤ 0 and no auto-top-up, refuse and post the "out of
   credits" notice once per hour per guild.
2. Make the provider call.
3. Write a `UsageEvent` and decrement the balance in one transaction.
4. If the balance crossed `autoTopUp.threshold`, enqueue a top-up.

Moderation, automod, welcome and the slash commands must keep working at zero
balance. They cost nothing and they are what stops a lapsed account becoming an
unmoderated server.

`ElevenLabs` is priced in the rate card but marked `integrated: false` — the bot
uses fish.audio with edge-tts as fallback today. Wiring it is separate work; the
credit system does not need to change when it lands.

## API surface

```
POST   /api/requests                 submit onboarding      → { requestId, stage }
GET    /api/requests/:id             poll provisioning status
GET    /api/account                  account + servers + balance
GET    /api/account/usage?days=30    daily rollups for the chart
POST   /api/account/credits          purchase a pack       → Stripe checkout URL
PUT    /api/account/autotopup        { enabled, threshold, packId }
PUT    /api/account/keys/:provider   enterprise key rotation (write-only)
POST   /api/servers/:id/tier         upgrade / downgrade

# staff only
GET    /api/admin/requests           the queue
PUT    /api/admin/requests/:id       edit modules, tier, notes
POST   /api/admin/requests/:id/approve
```

`GET /api/account/usage` returns pre-aggregated daily rollups, not raw
`UsageEvent` rows. At the volumes this is aimed at, a busy server generates
thousands of events a day and the chart wants thirty numbers.

## Things that will bite

- **Discord application limits.** One application per customer bot means
  hitting Discord's per-team application cap early. Verify the cap before
  promising "your own bot" at scale; the fallback is a shared application with
  per-guild configuration, which changes the product story.
- **Token custody.** Every managed bot's token is a credential we hold. It
  belongs in a secret manager with per-server isolation, not in the same
  SQLite file as the settings.
- **Tenancy.** The bot today is one process, one SQLite file, one server. Many
  thousands of tenants is a different architecture — sharding the gateway
  connection, and either a process per tenant or a multi-tenant gateway. That
  decision precedes any of this.
- **Credit fraud.** Credits bought on a stolen card and burned before the
  chargeback lands is the obvious attack. Rate-limit new accounts and hold the
  first purchase.
- **Staff auth on `admin.html`.** It is currently a static page anyone can
  open. It must be behind staff auth before it goes near a real domain.
