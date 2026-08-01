// The credit ledger: pricing arithmetic, metering, the zero-balance gate,
// and issuing credit. Real SQLite in a temp file per test, same as db.test.js
// — the arithmetic here is money, so it is exercised against the actual
// queries rather than a mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../src/db.js';
import * as ledger from '../src/credits/ledger.js';
import * as credits from '../src/credits/index.js';
import {
  CREDIT_RATES, CREDIT_PACKS, costMilli, toMilli, toCredits,
  replyKindForModel, chatKind, rateFor, packSavingPct,
} from '../src/credits/rates.js';
import { mp3DurationSec } from '../src/tts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-credits-'));
    db.initDb(path.join(dir, 'test.db'));
    credits.resetNotices();
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** An account with `creditAmount` credits, plus a server bound to a guild. */
function seedAccount({
  id = 'acct_1', venue = 'managed', creditAmount = 0, guildId = '111',
} = {}) {
  const handle = db.getDb();
  const now = Math.floor(Date.now() / 1000);
  handle.prepare(`
    INSERT INTO accounts (id, name, email, password_hash, venue, credits_milli,
                          created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?, ?, ?)
  `).run(id, `Account ${id}`, `${id}@example.test`, venue, toMilli(creditAmount), now, now);
  handle.prepare(`
    INSERT INTO platform_servers (id, account_id, guild_id, name, status, created_at)
    VALUES (?, ?, ?, 'Test Server', 'ready', ?)
  `).run(`srv_${id}`, id, guildId, now);
  return id;
}

/* ── Pricing arithmetic ─────────────────────────────────────────────────── */

test('a sub-credit rate survives the round trip to integer millicredits', () => {
  // The whole reason millicredits exist: background work is 0.2 credits and
  // is ~85% of call volume. An integer-credit ledger would bill it as zero.
  assert.equal(costMilli('background', 1), 200);
  assert.equal(costMilli('background', 5), 1000);
  assert.equal(toCredits(costMilli('background', 5)), 1);
});

test('fractional quantities price to the nearest millicredit', () => {
  // 12 seconds of transcription at 6 credits/minute.
  assert.equal(costMilli('transcription', 12 / 60), 1200);
  // 90 seconds of Fish TTS at 4 credits/minute.
  assert.equal(costMilli('tts-fish', 1.5), 6000);
});

test('an unknown billable kind throws rather than billing zero', () => {
  assert.throws(() => rateFor('reply-standrad'), /unknown billable kind/);
});

test('frontier models bill at the frontier rate, unknown models at standard', () => {
  assert.equal(replyKindForModel('anthropic/claude-opus-4'), 'reply-frontier');
  assert.equal(replyKindForModel('anthropic/claude-sonnet-4.5'), 'reply-frontier');
  assert.equal(replyKindForModel('openai/gpt-4o-mini'), 'reply-frontier');
  assert.equal(replyKindForModel('anthropic/claude-3.5-haiku'), 'reply-standard');
  assert.equal(replyKindForModel('openrouter/free'), 'reply-standard');
  // The safe direction for something we have never seen: cheap, not expensive.
  assert.equal(replyKindForModel('some-vendor/brand-new-model'), 'reply-standard');
});

test('background work bills the flat background rate whatever model ran it', () => {
  assert.equal(chatKind({ model: 'anthropic/claude-opus-4', background: true }), 'background');
  assert.equal(chatKind({ model: 'anthropic/claude-opus-4', background: false }), 'reply-frontier');
});

test('bigger packs really are cheaper per credit', () => {
  const savings = CREDIT_PACKS.map(packSavingPct);
  assert.equal(savings[0], 0);
  for (let i = 1; i < savings.length; i += 1) {
    assert.ok(savings[i] > savings[i - 1], `pack ${i} should beat pack ${i - 1}`);
  }
});

test('the rate card the site shows matches the one the bot bills on', () => {
  // site/js/platform.js keeps a copy so the marketing pages can render before
  // they have talked to the API. This is what stops the two drifting — a
  // price shown on the pricing page that is not the price charged is the
  // worst kind of bug to find out about from a customer.
  const source = readFileSync(path.join(HERE, '../../site/js/platform.js'), 'utf8');
  for (const rate of CREDIT_RATES) {
    const block = new RegExp(`id: '${rate.id}',[\\s\\S]{0,400}?credits: ([\\d.]+),`);
    const match = source.match(block);
    assert.ok(match, `site/js/platform.js is missing rate ${rate.id}`);
    assert.equal(
      Number(match[1]), rate.credits,
      `rate ${rate.id} is ${rate.credits} in the bot and ${match[1]} on the site`,
    );
  }
  for (const pack of CREDIT_PACKS) {
    const block = new RegExp(`id: '${pack.id}', credits: (\\d+), price: (\\d+)`);
    const match = source.match(block);
    assert.ok(match, `site/js/platform.js is missing pack ${pack.id}`);
    assert.equal(Number(match[1]), pack.credits, `pack ${pack.id} credits differ`);
    assert.equal(Number(match[2]), pack.price, `pack ${pack.id} price differs`);
  }
});

/* ── Issuing credit ─────────────────────────────────────────────────────── */

test('issuing credit adds to the balance', withDb(() => {
  seedAccount({ creditAmount: 0 });
  const result = ledger.issue({ accountId: 'acct_1', credits: 5000, reference: 'inv-1' });
  assert.equal(result.granted, true);
  assert.equal(ledger.balanceCredits('acct_1'), 5000);
}));

test('issuing a pack credits the pack amount and records what was sold', withDb(() => {
  seedAccount();
  ledger.issue({ accountId: 'acct_1', packId: 'pack-50', reference: 'transfer-abc' });
  assert.equal(ledger.balanceCredits('acct_1'), 30000);
  const [grant] = ledger.grantsFor('acct_1');
  assert.equal(grant.pack_id, 'pack-50');
  assert.equal(grant.amount_cents, 5000);
  assert.equal(grant.reference, 'transfer-abc');
}));

test('issuing twice with the same id credits once', withDb(() => {
  // The double-clicked "issue credits" button, and the property a payment
  // webhook will need when one exists.
  seedAccount();
  const first = ledger.issue({ accountId: 'acct_1', credits: 1000, id: 'grant_fixed' });
  const second = ledger.issue({ accountId: 'acct_1', credits: 1000, id: 'grant_fixed' });
  assert.equal(first.granted, true);
  assert.equal(second.granted, false);
  assert.equal(ledger.balanceCredits('acct_1'), 1000);
  assert.equal(ledger.grantsFor('acct_1').length, 1);
}));

test('issuing a non-positive or unknown amount is refused', withDb(() => {
  seedAccount();
  assert.throws(() => ledger.issue({ accountId: 'acct_1', credits: 0 }), /positive/);
  assert.throws(() => ledger.issue({ accountId: 'acct_1', credits: -50 }), /positive/);
  assert.throws(() => ledger.issue({ accountId: 'acct_1', packId: 'pack-nope' }), /unknown pack/);
}));

/* ── Spending ───────────────────────────────────────────────────────────── */

test('spending decrements the balance and records a usage event', withDb(() => {
  seedAccount({ creditAmount: 100 });
  const result = ledger.spend({
    accountId: 'acct_1', serverId: 'srv_acct_1', guildId: '111', kind: 'reply-standard',
  });
  assert.equal(result.creditsMilli, 2000);
  assert.equal(result.chargedMilli, 2000);
  assert.equal(ledger.balanceCredits('acct_1'), 98);
  const [event] = db.getDb().prepare('SELECT * FROM usage_events').all();
  assert.equal(event.kind, 'reply-standard');
  assert.equal(event.server_id, 'srv_acct_1');
  assert.equal(event.credits_milli, 2000);
}));

test('the balance floors at zero and the shortfall is recorded, not lost', withDb(() => {
  // Metering happens after the provider call returns, so a call CAN complete
  // that takes the balance under. The customer never carries a debt, but the
  // write-off has to stay a visible number.
  seedAccount({ creditAmount: 1 });
  const result = ledger.spend({ accountId: 'acct_1', kind: 'reply-frontier' });
  assert.equal(result.creditsMilli, 8000, 'billed the full list price');
  assert.equal(result.chargedMilli, 1000, 'took only what was there');
  assert.equal(ledger.balanceMilli('acct_1'), 0);
  assert.equal(ledger.writtenOffCredits('acct_1'), 7);
}));

test('a rate change does not rewrite what a past call cost', withDb(() => {
  // credits_milli is frozen at write time. This is the property that keeps a
  // customer's past invoice stable when the rate card moves.
  seedAccount({ creditAmount: 1000 });
  ledger.spend({ accountId: 'acct_1', kind: 'reply-standard' });
  const before = db.getDb().prepare('SELECT credits_milli FROM usage_events').get();
  assert.equal(before.credits_milli, costMilli('reply-standard'));
  // Nothing recomputes from the rate card on read.
  const rollup = ledger.usageByKind('acct_1');
  assert.equal(rollup.find((r) => r.kind === 'reply-standard').credits, 2);
}));

test('enterprise usage is recorded at list price but never charged', withDb(() => {
  seedAccount({ id: 'acct_ent', venue: 'enterprise', creditAmount: 0, guildId: '222' });
  const result = ledger.spend({ accountId: 'acct_ent', kind: 'reply-frontier', charge: false });
  assert.equal(result.creditsMilli, 8000, 'reported back to them at list price');
  assert.equal(result.chargedMilli, 0, 'but the provider bill is their own');
  assert.equal(ledger.balanceMilli('acct_ent'), 0);
}));

test('spending against an account that does not exist throws', withDb(() => {
  assert.throws(() => ledger.spend({ accountId: 'nope', kind: 'background' }), /no such account/);
}));

/* ── The gate ───────────────────────────────────────────────────────────── */

test('a guild with credit passes the gate and meters', withDb(() => {
  seedAccount({ creditAmount: 10, guildId: '111' });
  const ctx = credits.gate('111');
  assert.equal(ctx.accountId, 'acct_1');
  assert.equal(ctx.charge, true);
  credits.meter(ctx, { kind: 'reply-standard' });
  assert.equal(ledger.balanceCredits('acct_1'), 8);
}));

test('a guild with no credit is refused before any provider call', withDb(() => {
  seedAccount({ creditAmount: 0, guildId: '111' });
  assert.throws(() => credits.gate('111'), credits.InsufficientCreditsError);
}));

test('an unregistered guild is never metered and never gated', withDb(() => {
  // Self-hosted installs, and any server not on the platform. No flag to set:
  // absence from platform_servers IS the answer.
  assert.equal(credits.contextFor('999'), null);
  assert.equal(credits.gate('999'), null);
  assert.equal(credits.meter(null, { kind: 'reply-standard' }), null);
}));

test('an enterprise guild is never gated even at zero balance', withDb(() => {
  seedAccount({ id: 'acct_ent', venue: 'enterprise', creditAmount: 0, guildId: '222' });
  const ctx = credits.gate('222');
  assert.equal(ctx.charge, false);
  credits.meter(ctx, { kind: 'reply-frontier' });
  assert.equal(ledger.balanceMilli('acct_ent'), 0);
  const [event] = db.getDb().prepare('SELECT * FROM usage_events').all();
  assert.equal(event.credits_milli, 8000);
  assert.equal(event.charged_milli, 0);
}));

test('a broken ledger lets the bot keep answering rather than silencing it', () => {
  // No initDb at all — every query throws. One database problem on our side
  // must not take every customer's bot down at once.
  credits.resetNotices();
  assert.equal(credits.contextFor('111'), null);
  assert.doesNotThrow(() => credits.gate('111'));
});

test('the free paths cannot reach a billable provider at all', () => {
  // The promise is that moderation, automod, welcome and the slash commands
  // keep working at a zero balance — that is what stops a lapsed account
  // becoming an unmoderated server. Today they hold because those modules
  // never call a paid provider, which is a stronger guarantee than gating
  // them correctly. This test is what keeps it that way: an import added
  // here would silently put moderation behind the credit gate.
  const FREE = [
    'automod.js', 'welcome.js', 'deescalation.js', 'phrases.js', 'botName.js',
    'commands/ban.js', 'commands/kick.js', 'commands/timeout.js', 'commands/warn.js',
    'commands/purge.js', 'commands/slowmode.js', 'commands/lock.js',
    'commands/giverole.js', 'commands/createchannel.js', 'commands/ping.js',
    'commands/serverinfo.js', 'commands/userinfo.js', 'commands/say.js',
  ];
  const BILLABLE = /from '\.\.?\/?(openrouter|tts)\.js'|transcribePcm/;
  for (const name of FREE) {
    const file = path.join(HERE, '../src', name);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue; // command set moves around; only check what is there
    }
    assert.equal(
      BILLABLE.test(source), false,
      `${name} reaches a billable provider — it would stop working at zero balance`,
    );
  }
});

/* ── The out-of-credits notice ──────────────────────────────────────────── */

test('the out-of-credits notice is once an hour per guild', () => {
  credits.resetNotices();
  const t0 = 1_000_000_000_000;
  assert.equal(credits.shouldNotify('111', t0), true);
  assert.equal(credits.shouldNotify('111', t0 + 60_000), false);
  assert.equal(credits.shouldNotify('222', t0 + 60_000), true, 'a different server is separate');
  assert.equal(credits.shouldNotify('111', t0 + 3_600_001), true, 'and it re-arms after an hour');
});

/* ── Reporting ──────────────────────────────────────────────────────────── */

test('daily usage fills gaps with zeroes and totals per kind', withDb(() => {
  seedAccount({ creditAmount: 10000 });
  ledger.spend({ accountId: 'acct_1', kind: 'reply-standard' });
  ledger.spend({ accountId: 'acct_1', kind: 'reply-standard' });
  ledger.spend({ accountId: 'acct_1', kind: 'background', quantity: 10 });
  const days = ledger.usageDaily('acct_1', 7);
  assert.equal(days.length, 7);
  assert.equal(days.slice(0, 6).every((d) => d.credits === 0), true);
  const today = days.at(-1);
  assert.equal(today.credits, 6, '2 replies at 2 + 10 background at 0.2');
  assert.equal(today.kinds['reply-standard'].quantity, 2);
  assert.equal(today.kinds.background.credits, 2);
}));

test('per-server spend is recoverable even though the balance is pooled', withDb(() => {
  seedAccount({ creditAmount: 1000 });
  ledger.spend({ accountId: 'acct_1', serverId: 'srv_a', kind: 'reply-standard' });
  ledger.spend({ accountId: 'acct_1', serverId: 'srv_b', kind: 'reply-frontier' });
  const byServer = Object.fromEntries(
    ledger.usageByServer('acct_1').map((r) => [r.serverId, r.credits]),
  );
  assert.deepEqual(byServer, { srv_a: 2, srv_b: 8 });
}));

test('burn rate and days remaining come off real usage', withDb(() => {
  seedAccount({ creditAmount: 700 });
  for (let i = 0; i < 35; i += 1) ledger.spend({ accountId: 'acct_1', kind: 'reply-standard' });
  // 70 credits spent, all today, averaged over a 7-day window.
  assert.equal(ledger.burnRate('acct_1', 7), 10);
  assert.equal(ledger.daysRemaining('acct_1', 7), 63);
}));

test('an idle account has an infinite runway rather than a divide by zero', withDb(() => {
  seedAccount({ creditAmount: 500 });
  assert.equal(ledger.daysRemaining('acct_1'), Infinity);
}));

/* ── Measuring what was synthesized ─────────────────────────────────────── */

/** A fake CBR MPEG-1 Layer III frame header at `kbps`, then `bytes` of body. */
function fakeMp3(kbps, bytes) {
  const rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const header = Buffer.from([
    0xff,
    0xfb, // MPEG 1, Layer III, no CRC
    (rates.indexOf(kbps) << 4) | (0 << 2), // bitrate index, 44100 Hz
    0x00,
  ]);
  return Buffer.concat([header, Buffer.alloc(bytes - 4)]);
}

test('TTS duration is read from the audio, not guessed from the text', () => {
  // 128kbps CBR = 16000 bytes per second.
  assert.equal(Math.round(mp3DurationSec(fakeMp3(128, 160_000))), 10);
  assert.equal(Math.round(mp3DurationSec(fakeMp3(64, 80_000))), 10);
});

test('unreadable audio bills nothing rather than billing a guess', () => {
  // A format change upstream should show up as revenue going missing in the
  // report, not as customers charged against an invented number.
  assert.equal(mp3DurationSec(Buffer.alloc(0)), 0);
  assert.equal(mp3DurationSec(Buffer.from('not audio at all')), 0);
  assert.equal(mp3DurationSec(null), 0);
});

test('an ID3 tag in front of the audio does not break the duration', () => {
  const id3 = Buffer.alloc(20);
  id3.write('ID3', 0, 'ascii');
  id3[6] = 0; id3[7] = 0; id3[8] = 0; id3[9] = 10; // 10 bytes of tag body
  const audio = Buffer.concat([id3, fakeMp3(128, 160_000)]);
  assert.equal(Math.round(mp3DurationSec(audio)), 10);
});
