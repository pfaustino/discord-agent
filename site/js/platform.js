/* The platform model: venues, credit pricing, provisioning state, and the
   demo store the onboarding form, customer dashboard and admin queue all
   share.

   Everything here is the front-end's view of what the backend will own. The
   shapes match docs/platform-spec.md one-for-one, so swapping localStorage for
   real API calls is a change to `Store` alone — no screen touches storage
   directly. */

/* ── Service venues ─────────────────────────────────────────────────────── */

const VENUES = [
  {
    id: 'managed',
    name: 'Managed',
    tagline: 'We supply the keys. You buy credits.',
    detail:
      'We hold the OpenRouter and voice provider accounts, meter what your bot '
      + 'actually uses, and bill it against a credit balance you top up. Nothing '
      + 'to sign up for elsewhere, and no provider bill of your own.',
    forWho: 'Almost everyone. Communities, servers, small teams.',
    billing: 'Subscription tier + usage credits',
    setup: 'Automated — minutes',
  },
  {
    id: 'enterprise',
    name: 'Enterprise (bring your own keys)',
    tagline: 'Your provider accounts. We run the platform.',
    detail:
      'You hold the provider contracts and the spend sits on your own accounts. '
      + 'We handle provisioning, the dashboard, upgrades and support. Usage is '
      + 'reported back to you but never billed by us.',
    forWho: 'Orgs with procurement, existing provider contracts, or data rules.',
    billing: 'Flat platform fee per server',
    setup: 'Assisted — key handover and a call',
  },
];

/* ── Credit model ───────────────────────────────────────────────────────────

   One credit is one cent of list price. Rates are what we charge, already
   inclusive of margin over provider cost — the dashboard never shows a
   customer a raw provider price.

   `integrated: false` means the platform can price it but the bot cannot use
   it yet. It is shown greyed rather than hidden, because the honest answer to
   "do you support ElevenLabs" is "priced, not wired up". */

const CREDIT_RATES = [
  {
    id: 'reply-standard',
    provider: 'OpenRouter',
    name: 'AI reply — standard model',
    credits: 2,
    unit: 'per reply',
    integrated: true,
    note: 'Haiku-class. The default for chat.',
  },
  {
    id: 'reply-frontier',
    provider: 'OpenRouter',
    name: 'AI reply — frontier model',
    credits: 8,
    unit: 'per reply',
    integrated: true,
    note: 'Opus/Sonnet-class, when a server picks one.',
  },
  {
    id: 'background',
    provider: 'OpenRouter',
    name: 'Background work',
    credits: 0.2,
    unit: 'per call',
    integrated: true,
    note: 'Memory upkeep, signal classification, de-escalation. ~85% of call volume.',
  },
  {
    id: 'transcription',
    provider: 'OpenAI / Groq',
    name: 'Voice transcription',
    credits: 6,
    unit: 'per minute',
    integrated: true,
    note: 'Per speaker. Silence and noise blips are dropped before they bill.',
  },
  {
    id: 'tts-fish',
    provider: 'Fish Audio',
    name: 'Spoken reply — Fish Audio',
    credits: 4,
    unit: 'per minute',
    integrated: true,
    note: 'The default voice. edge-tts is the free fallback and bills nothing.',
  },
  {
    id: 'tts-eleven',
    provider: 'ElevenLabs',
    name: 'Spoken reply — ElevenLabs',
    credits: 12,
    unit: 'per minute',
    integrated: false,
    note: 'Priced and ready to meter. Not yet wired into the bot — see the roadmap.',
  },
];

/* Top-up packs. Bigger packs are cheaper per credit; that discount is the
   only lever that makes prepayment worth anything to the customer. */
const CREDIT_PACKS = [
  { id: 'pack-10', credits: 5000, price: 10 },
  { id: 'pack-50', credits: 30000, price: 50, popular: true },
  { id: 'pack-100', credits: 75000, price: 100 },
  { id: 'pack-240', credits: 200000, price: 240 },
];

/** Discount vs. the smallest pack's per-credit rate. */
function packSavingPct(pack) {
  const base = CREDIT_PACKS[0].price / CREDIT_PACKS[0].credits;
  const rate = pack.price / pack.credits;
  return Math.round((1 - rate / base) * 100);
}

/* ── Provisioning ──────────────────────────────────────────────────────────

   A submitted request walks this pipeline. `auto: true` steps run without a
   human; the rest land in the admin queue. This is the honest shape of "some
   of it is automated, and then we manage what gets selected". */

const PIPELINE = [
  {
    id: 'submitted',
    name: 'Submitted',
    auto: true,
    detail: 'Form received, plan and modules recorded.',
  },
  {
    id: 'validated',
    name: 'Validated',
    auto: true,
    detail: 'Module set checked against the tier; conflicts and impossible combinations rejected.',
  },
  {
    id: 'review',
    name: 'Review',
    auto: false,
    detail: 'A human confirms what gets switched on. Enterprise key handover happens here.',
  },
  {
    id: 'provisioning',
    name: 'Provisioning',
    auto: true,
    detail: 'Discord application registered, token minted, database and volume allocated.',
  },
  {
    id: 'ready',
    name: 'Ready',
    auto: true,
    detail: 'Invite link issued and dashboard access granted.',
  },
];

const PIPELINE_INDEX = Object.fromEntries(PIPELINE.map((s, i) => [s.id, i]));

/** Which requests need a human, and why. Drives the admin queue's filter. */
function needsHuman(request) {
  if (request.venue === 'enterprise') return 'Key handover and contract';
  if (request.stage === 'review') return 'Module set confirmation';
  return null;
}

/* ── Demo store ────────────────────────────────────────────────────────────

   localStorage standing in for the backend. Every screen goes through here,
   so replacing it with fetch() calls is a single-file change. Seeded on first
   run so the dashboard and admin queue have something to show. */

const STORE_KEY = 'max-platform-v1';

const Store = {
  read() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* corrupt draft is not worth failing over */ }
    const seeded = seed();
    Store.write(seeded);
    return seeded;
  },

  write(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
    return data;
  },

  update(fn) {
    const data = Store.read();
    fn(data);
    return Store.write(data);
  },

  reset() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    return Store.read();
  },
};

/** Deterministic ids — no Date.now() collisions across a fast double-submit. */
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}${idCounter.toString(36)}`;
}

function seed() {
  const now = Date.now();
  const day = 86400000;
  return {
    account: {
      id: 'acct_demo',
      name: 'Northwind Collective',
      email: 'ops@northwind.example',
      venue: 'managed',
      tier: 'voice',
      credits: 41850,
      autoTopUp: { enabled: true, threshold: 5000, packId: 'pack-50' },
      createdAt: now - day * 47,
    },
    servers: [
      {
        id: 'srv_1', name: 'Northwind HQ', members: 2840, botName: 'Max',
        accent: 'blurple', status: 'ready', tier: 'voice',
        modules: ['mod-commands', 'roles-channels', 'automod', 'welcome', 'chat',
          'persona', 'documents', 'voice-join', 'transcription', 'tts'],
        creditsThisPeriod: 18420, provisionedAt: now - day * 40,
      },
      {
        id: 'srv_2', name: 'Northwind Dev', members: 190, botName: 'Maxine',
        accent: 'tide', status: 'ready', tier: 'core',
        modules: ['mod-commands', 'automod', 'chat', 'persona', 'search', 'repo-analysis'],
        creditsThisPeriod: 3110, provisionedAt: now - day * 22,
      },
      {
        id: 'srv_3', name: 'Northwind Community', members: 11500, botName: 'Max',
        accent: 'ember', status: 'provisioning', tier: 'voice',
        modules: ['mod-commands', 'automod', 'welcome', 'chat', 'voice-join', 'tts'],
        creditsThisPeriod: 0, provisionedAt: null,
      },
    ],
    /* 30 days of usage, newest last. Shaped rather than random so the burn-rate
       and projection maths have something realistic to chew on. */
    usage: buildUsage(now, day),
    requests: [
      {
        id: 'req_seed1', venue: 'managed', accountName: 'Harbour Guild',
        email: 'admin@harbour.example', serverName: 'Harbour Guild',
        botName: 'Skipper', tier: 'core', stage: 'review',
        modules: ['mod-commands', 'automod', 'welcome', 'chat', 'persona', 'documents'],
        submittedAt: now - 3600000 * 5, notes: '',
      },
      {
        id: 'req_seed2', venue: 'enterprise', accountName: 'Meridian Labs',
        email: 'it@meridian.example', serverName: 'Meridian Internal',
        botName: 'Atlas', tier: 'autonomy', stage: 'review',
        modules: ['mod-commands', 'roles-channels', 'automod', 'chat', 'persona',
          'documents', 'search', 'repo-analysis', 'repo-review', 'knowledge',
          'voice-join', 'transcription', 'tts', 'pressure'],
        keys: { openrouter: 'pending', transcription: 'pending', fish: 'not-supplied' },
        submittedAt: now - 3600000 * 30, notes: 'Wants SSO. Legal reviewing DPA.',
      },
      {
        id: 'req_seed3', venue: 'managed', accountName: 'Pixel Pals',
        email: 'mod@pixelpals.example', serverName: 'Pixel Pals',
        botName: 'Pip', tier: 'hobby', stage: 'ready',
        modules: ['mod-commands', 'automod', 'chat'],
        submittedAt: now - 3600000 * 52, notes: '',
      },
    ],
  };
}

function buildUsage(now, day) {
  const out = [];
  for (let i = 29; i >= 0; i -= 1) {
    const weekday = new Date(now - day * i).getDay();
    const quiet = weekday === 0 || weekday === 6;
    const base = quiet ? 380 : 760;
    // A deterministic wobble, so the chart looks alive without Math.random()
    // producing a different history on every page load.
    const wobble = ((i * 37) % 23) / 23;
    out.push({
      day: now - day * i,
      replies: Math.round(base * (0.75 + wobble * 0.5)),
      background: Math.round(base * 3.1 * (0.8 + wobble * 0.4)),
      voiceMinutes: Math.round((quiet ? 9 : 26) * (0.6 + wobble * 0.8)),
    });
  }
  return out;
}

/** Credits consumed by one day's usage row, per the rate card. */
function creditsForDay(row) {
  const rate = (id) => CREDIT_RATES.find((r) => r.id === id).credits;
  return row.replies * rate('reply-standard')
    + row.background * rate('background')
    + row.voiceMinutes * (rate('transcription') + rate('tts-fish'));
}

/** Mean daily spend over the last `days` days. */
function burnRate(usage, days = 7) {
  const window = usage.slice(-days);
  if (!window.length) return 0;
  return window.reduce((sum, row) => sum + creditsForDay(row), 0) / window.length;
}

/** Whole days of balance left at the current burn rate. Infinity if idle. */
function daysRemaining(credits, usage) {
  const rate = burnRate(usage);
  if (rate <= 0) return Infinity;
  return Math.floor(credits / rate);
}

/** Credits grouped by provider over a window, for the usage breakdown. */
function usageByProvider(usage, days = 30) {
  const window = usage.slice(-days);
  const totals = { OpenRouter: 0, 'OpenAI / Groq': 0, 'Fish Audio': 0 };
  const rate = (id) => CREDIT_RATES.find((r) => r.id === id).credits;
  for (const row of window) {
    totals.OpenRouter += row.replies * rate('reply-standard')
      + row.background * rate('background');
    totals['OpenAI / Groq'] += row.voiceMinutes * rate('transcription');
    totals['Fish Audio'] += row.voiceMinutes * rate('tts-fish');
  }
  return totals;
}

const fmt = {
  credits: (n) => Math.round(n).toLocaleString('en-US'),
  money: (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  compact: (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n))),
  when: (ts) => {
    if (!ts) return '—';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  },
};

window.PLATFORM = {
  VENUES,
  CREDIT_RATES,
  CREDIT_PACKS,
  PIPELINE,
  PIPELINE_INDEX,
  packSavingPct,
  needsHuman,
  Store,
  newId,
  creditsForDay,
  burnRate,
  daysRemaining,
  usageByProvider,
  fmt,
};
