# Site

The customer-facing half of the platform: the landing page, the subscription
catalog, the order form, the customer dashboard and the internal queue.

The marketing pages (`index.html`, `pricing.html`) are still a design
showcase. **The rest is real** — orders submit, accounts sign in, balances and
usage are what the bot actually metered, and staff issue credit from
`admin.html`. What is *not* real is checkout: there is no card processing, so
a customer pays out of band and somebody issues the credits by hand. See
`PLATFORM-SPEC.md` for exactly what is and is not built.

The bot serves it. `nodebot/src/web/server.js` mounts this folder read-only at
`/site/`, alongside the dashboard and the platform API on the same port — so
wherever the dashboard lives, the site is at `<dashboard>/site/`. The pages are
public and served `no-cache`, so a redeploy shows changes immediately. No bot
logic imports anything from here.

## Run it

Start the bot and open `/site/`. There are links both ways — the dashboard's
login card and Overview tab point at the site, and the site's footer points
back at the dashboard.

There is no build step and no dependencies. The marketing pages still open
straight off the filesystem, or from any static server:

```bash
cd site && python3 -m http.server 8000
```

`build.html`, `app.html` and `admin.html` need the bot behind them — they talk
to the platform API on the same origin. Served that way they degrade honestly
rather than breaking: the pages render and say they could not reach the server.

To get into `admin.html`, sign up on `app.html` with an email listed in
`PLATFORM_STAFF_EMAILS`.

## Pages

| File | What it is |
|---|---|
| `index.html` | Landing page — hero with a live Discord mock, capability pillars, deep-dives on memory / voice / initiative, how-it-works, tier preview, FAQ |
| `pricing.html` | Four tiers with a monthly/annual toggle, the full capability matrix, add-ons, self-host band, FAQ |
| `build.html` | The order form: venue → identity → personality → capabilities → voice → plan → submit, with a live price rail. **Submits for real.** No account needed |
| `app.html` | Customer dashboard — sign-in, live balance, burn rate, metered usage, bots. Enterprise accounts get a usage report and no balance |
| `admin.html` | Internal queue — walk orders through the pipeline, manage what each customer gets, attach Discord servers, and issue credit. Staff only |

`PLATFORM-SPEC.md` is the contract these screens run against: data model,
pipeline, metering rules, API surface, what is built, and the things that will
bite at scale.

## Files

```
css/site.css     design system + every component
js/catalog.js    tiers, capabilities, add-ons, FAQ — the product catalog
js/platform.js   venues, credit rates, packs, pipeline, and the API client
js/site.js       nav, scroll reveals, FAQ rendering, hero motion
js/tiers.js      tier cards, billing toggle, capability matrix, add-ons
js/build.js      the onboarding wizard
js/app.js        customer dashboard
js/admin.js      internal provisioning queue
```

## Two sources of truth

`js/catalog.js` owns the **product** — tiers and capabilities. `js/platform.js`
owns the **business** — venues, credit rates, packs, the pipeline, and the API
client every screen goes through. No screen calls `fetch` itself.

The pricing and pipeline constants in `platform.js` are a **copy** of what the
backend owns (`nodebot/src/credits/rates.js`, `nodebot/src/platform/`). They
exist so the marketing pages render instantly and still render with the backend
down; `API.catalog()` overwrites them on load. `nodebot`'s test suite fails if
the two ever disagree — a price shown here that is not the price charged is the
worst kind of bug to hear about from a customer. The same check covers
`catalog.js`: a capability cannot be advertised at one tier and validated at
another.

Plain scripts rather than ES modules, so the site also opens straight off the
filesystem without a server in front of it.

## The catalog is the source of truth

`js/catalog.js` holds every tier and every capability. Each capability declares
the lowest tier that includes it, and whether it appears as a toggle in the
builder:

```js
{ id: 'wake', name: 'Wake phrases', tier: 'voice', builder: true, detail: '…' }
```

The pricing matrix and the builder both render from that array, so a capability
cannot be listed in one place and missing from the other, and a tier change is a
one-line edit. Adding a capability to the product means adding one object here.

## How the builder works

State lives in one object and everything else is derived from it:

- **Required tier** — the highest tier any switched-on module needs. Toggling
  Pressure engine moves you to Autonomy and the rail's price updates in the same
  frame. You can select a tier above what you need; you cannot select one below.
- **Invite permissions** — a Discord permission bitfield accumulated from the
  modules you turned on (`MODULE_PERMS` in `build.js`), never Administrator. The
  deploy step shows the computed number.
- **Client ID** — a stable pretend snowflake hashed from the bot name, so the
  same build always produces the same example link.

Drafts persist to `localStorage` under `max-build-v1`; **Start over** clears it.

## Tiers

| Tier | Price | The line |
|---|---|---|
| Hobby | $0 | Full moderation stack, 1 server, 300 AI replies |
| Core | $19 | Persistent memory, persona, tools, full model catalog |
| Voice | $49 | Joins voice, per-speaker transcription, wake phrases, TTS |
| Autonomy | $99 | The pressure engine — he speaks up first |

Annual billing charges ten months for twelve.

## Notes on the copy

The feature claims are drawn from the real project — the `--experimental-sqlite`
detail in the hero mock, the 25-second follow-up window, the bracketed wake
phrase syntax, the six pressure reservoirs and the gate's checks are all things
the bot actually does. Prices and tier limits are still invented, and the tier
limits in particular are **not enforced anywhere** — a tier decides which
capabilities an order may switch on, not how many replies a bot gets. Credits
are what actually meters usage.
