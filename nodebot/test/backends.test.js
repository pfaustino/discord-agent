// Rerouting around a rate-limited backend: the model catalog, the cooldowns,
// the shortlist, and the deterministic answer matching that has to work while
// the model itself is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import * as catalog from '../src/backends/catalog.js';
import * as switching from '../src/backends/switching.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-backends-'));
    db.initDb(path.join(dir, 'test.db'));
    switching.clearCooldowns();
    switching.clearOffer('1');
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** An OpenRouter /models entry, in the shape the real endpoint returns. */
const entry = (id, {
  name, prompt = '0', completion = '0', context = 128000, tools = true,
} = {}) => ({
  id,
  name: name || id,
  context_length: context,
  pricing: { prompt, completion, request: '0', image: '0' },
  supported_parameters: tools ? ['tools', 'tool_choice', 'max_tokens'] : ['max_tokens'],
});

const fakeFetch = (entries) => async () => ({
  ok: true,
  json: async () => ({ data: entries }),
});

/** A realistic spread: free, cheap paid, and steady-vendor. */
function seedCatalog() {
  const handle = db.getDb();
  const insert = handle.prepare(`
    INSERT INTO model_catalog
      (id, name, context_length, prompt_price, completion_price, supports_tools, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const at = Math.floor(Date.now() / 1000);
  insert.run('openrouter/free', 'OpenRouter: Auto (free)', 64000, 0, 0, 1, at);
  insert.run('someone/tiny-free', 'Someone: Tiny (free)', 32000, 0, 0, 1, at);
  insert.run('budget/cheapo', 'Budget: Cheapo', 128000, 0.05, 0.1, 1, at);
  insert.run('anthropic/claude-3.5-haiku', 'Anthropic: Claude 3.5 Haiku', 200000, 0.8, 4, 1, at);
  insert.run('anthropic/claude-opus-4', 'Anthropic: Claude Opus 4', 200000, 15, 75, 1, at);
  insert.run('nontool/parrot', 'Nontool: Parrot', 8000, 0.01, 0.02, 0, at);
}

/* ── Catalog ────────────────────────────────────────────────────────────── */

test('per-token prices are stored per million tokens', () => {
  // The API returns "0.0000008" per token; carrying that around invites a
  // misplaced zero in something that decides what a customer is charged.
  const d = catalog.distil(entry('x/y', { prompt: '0.0000008', completion: '0.000004' }));
  assert.equal(d.promptPrice, 0.8);
  assert.equal(d.completionPrice, 4);
});

test('tool support is read off supported_parameters', () => {
  assert.equal(catalog.distil(entry('a/b')).supportsTools, true);
  assert.equal(catalog.distil(entry('a/b', { tools: false })).supportsTools, false);
  assert.equal(catalog.distil({ id: null }), null);
});

test('refresh stores the catalog and replaces it wholesale', withDb(async () => {
  await catalog.refresh({ fetchImpl: fakeFetch([entry('a/one'), entry('b/two')]) });
  assert.equal(catalog.list().length, 2);

  // A model that vanished from OpenRouter must vanish here, or she keeps
  // offering something that no longer exists.
  await catalog.refresh({ fetchImpl: fakeFetch([entry('a/one')]) });
  const ids = catalog.list().map((m) => m.id);
  assert.deepEqual(ids, ['a/one']);
}));

test('a failed refresh keeps the previous catalog', withDb(async () => {
  await catalog.refresh({ fetchImpl: fakeFetch([entry('a/one')]) });
  const failing = async () => { throw new Error('network down'); };
  assert.equal(await catalog.refresh({ fetchImpl: failing }), 0);
  assert.equal(catalog.list().length, 1, 'the old list is still there to fall back to');

  // An empty response is the same kind of non-answer as a network failure.
  assert.equal(await catalog.refresh({ fetchImpl: fakeFetch([]) }), 0);
  assert.equal(catalog.list().length, 1);
}));

test('toolsOnly filters out models that cannot call tools', withDb(() => {
  seedCatalog();
  assert.equal(catalog.list().length, 6);
  assert.equal(catalog.list({ toolsOnly: true }).length, 5);
}));

test('an empty catalog reads as stale rather than fresh', withDb(() => {
  assert.equal(catalog.isEmpty(), true);
  assert.equal(catalog.isStale(), true);
  seedCatalog();
  assert.equal(catalog.isStale(), false);
}));

test('catalog reads never throw without a database', () => {
  db.closeDb();
  assert.deepEqual(catalog.list(), []);
  assert.equal(catalog.get('a/b'), null);
  assert.equal(catalog.fetchedAt(), null);
});

/* ── Cooldowns ──────────────────────────────────────────────────────────── */

test('a daily quota parks a model much longer than a burst limit', () => {
  // Both arrive as 429. A per-minute limit lifts in a minute; a daily
  // free-model quota does not, and retrying it all afternoon is pointless.
  assert.equal(switching.cooldownFor('Rate limit exceeded: free-models-per-day-high-balance'),
    switching.DAILY_QUOTA_COOLDOWN_MS);
  assert.equal(switching.cooldownFor('rate limit exceeded, please slow down'),
    switching.DEFAULT_COOLDOWN_MS);
});

test('a parked model is unavailable until its cooldown lifts', () => {
  switching.clearCooldowns();
  const t0 = 1_000_000_000_000;
  assert.equal(switching.isAvailable('a/b', t0), true);
  switching.markUnavailable('a/b', { reason: 'rate limited', nowMs: t0 });
  assert.equal(switching.isAvailable('a/b', t0 + 60_000), false);
  assert.equal(switching.isAvailable('a/b', t0 + switching.DEFAULT_COOLDOWN_MS + 1), true);
});

/* ── Shortlist ──────────────────────────────────────────────────────────── */

test('the shortlist spans tiers instead of offering three free models', withDb(() => {
  // Three free models are three models that hit the same daily quota on the
  // same day, which is the failure this is routing around.
  seedCatalog();
  switching.clearCooldowns();
  const options = switching.shortlist('1', 'chat');
  assert.equal(options.length, 3);
  assert.equal(options.filter((o) => o.free).length, 1, 'exactly one free option');
  assert.ok(options.some((o) => o.id.startsWith('anthropic/')), 'one steady-vendor option');
}));

test('the shortlist never offers a model that cannot call tools', withDb(() => {
  seedCatalog();
  switching.clearCooldowns();
  const chat = switching.shortlist('1', 'chat', { limit: 10 });
  assert.equal(chat.some((o) => o.id === 'nontool/parrot'), false);
  // Background work has no tools, so it can use anything.
  const utility = switching.shortlist('1', 'utility', { limit: 10 });
  assert.equal(utility.some((o) => o.id === 'nontool/parrot'), true);
}));

test('the shortlist skips parked models and the one already in use', withDb(() => {
  seedCatalog();
  switching.clearCooldowns();
  db.setSetting('1', 'ai_model', 'budget/cheapo');
  switching.markUnavailable('openrouter/free', { reason: 'free-models-per-day' });
  const ids = switching.shortlist('1', 'chat', { limit: 10 }).map((o) => o.id);
  assert.equal(ids.includes('budget/cheapo'), false, 'not the one that just failed');
  assert.equal(ids.includes('openrouter/free'), false, 'not one that is parked');
}));

test('each option says what it would cost under the rate card', withDb(() => {
  // Switching backends can change what a customer is billed per reply, so
  // that has to be on screen before the switch, not discovered on the invoice.
  seedCatalog();
  switching.clearCooldowns();
  // Park the default on something outside the fixture, so neither Anthropic
  // model is filtered out as "the one already in use".
  db.setSetting('1', 'ai_model', 'openrouter/free');
  const options = switching.shortlist('1', 'chat', { limit: 10 });
  const opus = options.find((o) => o.id === 'anthropic/claude-opus-4');
  const haiku = options.find((o) => o.id === 'anthropic/claude-3.5-haiku');
  assert.match(opus.costNote, /8 credits per reply/);
  assert.match(haiku.costNote, /2 credits per reply/);
}));

test('a curated list replaces the automatic pick entirely', withDb(() => {
  seedCatalog();
  switching.clearCooldowns();
  db.setSetting('1', 'ai_model', 'openrouter/free');
  const options = switching.shortlist('1', 'chat', {
    curated: ['anthropic/claude-3.5-haiku', 'budget/cheapo'],
  });
  assert.deepEqual(options.map((o) => o.id), ['anthropic/claude-3.5-haiku', 'budget/cheapo']);
}));

test('spoken labels drop the vendor prefix nobody says out loud', () => {
  assert.equal(switching.spokenLabel('Anthropic: Claude 3.5 Haiku', 'x'), 'Claude 3.5 Haiku');
  assert.equal(switching.spokenLabel('OpenRouter: Auto (free)', 'x'), 'Auto');
  assert.equal(switching.spokenLabel('', 'a/b'), 'a/b');
});

/* ── Switching ──────────────────────────────────────────────────────────── */

test('switching records what it switched away from', withDb(() => {
  seedCatalog();
  db.setSetting('1', 'ai_model', 'budget/cheapo');
  const result = switching.switchTo('1', 'chat', 'anthropic/claude-3.5-haiku');
  assert.equal(result.changed, true);
  assert.equal(result.from, 'budget/cheapo');
  assert.equal(switching.currentModel('1', 'chat'), 'anthropic/claude-3.5-haiku');
  assert.equal(switching.previousModel('1', 'chat'), 'budget/cheapo');
}));

test('switching to the model already in use changes nothing', withDb(() => {
  db.setSetting('1', 'ai_model', 'budget/cheapo');
  const result = switching.switchTo('1', 'chat', 'budget/cheapo');
  assert.equal(result.changed, false);
  assert.equal(switching.previousModel('1', 'chat'), null, 'and does not clobber the undo target');
}));

test('chat and utility are switched independently', withDb(() => {
  seedCatalog();
  switching.switchTo('1', 'utility', 'someone/tiny-free');
  assert.equal(switching.currentModel('1', 'utility'), 'someone/tiny-free');
  assert.notEqual(switching.currentModel('1', 'chat'), 'someone/tiny-free');
}));

test('background work reroutes itself without asking', withDb(() => {
  // Nobody is listening at 3am when memory consolidation fails.
  seedCatalog();
  switching.clearCooldowns();
  db.setSetting('1', 'ai_utility_model', 'openrouter/free');
  switching.markUnavailable('openrouter/free', { reason: 'free-models-per-day' });
  const rotated = switching.rotateBackground('1');
  assert.ok(rotated);
  assert.notEqual(rotated.to, 'openrouter/free');
  assert.equal(switching.currentModel('1', 'utility'), rotated.to);
}));

test('background rerouting gives up loudly when there is nowhere to go', withDb(() => {
  switching.clearCooldowns();
  assert.equal(switching.rotateBackground('1'), null, 'empty catalog means no alternative');
}));

/* ── Answering the offer ────────────────────────────────────────────────── */

function offerFixture() {
  seedCatalog();
  switching.clearCooldowns();
  db.setSetting('1', 'ai_model', 'openrouter/free');
  const options = switching.shortlist('1', 'chat');
  switching.offer('1', 'chat', options);
  return options;
}

test('a letter picks the matching option', withDb(() => {
  const options = offerFixture();
  const answer = switching.resolveOffer('1', 'B');
  assert.equal(answer.action, 'switch');
  assert.equal(answer.model, options[1].id);
}));

test('ordinals and filler words still pick the right option', withDb(() => {
  const options = offerFixture();
  for (const said of ['option c', 'the third one', 'switch to number three', 'go with c']) {
    switching.offer('1', 'chat', options);
    const answer = switching.resolveOffer('1', said);
    assert.equal(answer?.model, options[2].id, `"${said}" should pick C`);
  }
}));

test('a spoken model name picks the matching option', withDb(() => {
  const options = offerFixture();
  const haiku = options.find((o) => /haiku/i.test(o.label));
  if (haiku) {
    const answer = switching.resolveOffer('1', 'switch to haiku');
    assert.equal(answer?.model, haiku.id);
  }
}));

test('"switch back" returns to the previous model', withDb(() => {
  seedCatalog();
  db.setSetting('1', 'ai_model', 'budget/cheapo');
  switching.switchTo('1', 'chat', 'anthropic/claude-3.5-haiku');
  switching.offer('1', 'chat', switching.shortlist('1', 'chat'));
  const answer = switching.resolveOffer('1', 'switch back');
  assert.equal(answer.action, 'back');
  assert.equal(answer.model, 'budget/cheapo');
  assert.match(switching.applyAnswer('1', answer), /Switched back to/);
  assert.equal(switching.currentModel('1', 'chat'), 'budget/cheapo');
}));

test('declining leaves the model alone', withDb(() => {
  offerFixture();
  for (const said of ['never mind', 'cancel', 'no thanks', 'leave it']) {
    switching.offer('1', 'chat', switching.shortlist('1', 'chat'));
    assert.equal(switching.resolveOffer('1', said).action, 'cancel');
  }
  assert.equal(switching.currentModel('1', 'chat'), 'openrouter/free');
}));

test('an unrelated sentence falls through instead of being eaten', withDb(() => {
  // Somebody who ignores the offer and keeps talking must still be heard —
  // this runs before normal message handling, so a false match would swallow
  // real conversation.
  offerFixture();
  for (const said of [
    'can you summarise the last meeting',
    'what did Alice say about the deploy',
    'a really long sentence that merely happens to contain the letter b somewhere in it',
  ]) {
    assert.equal(switching.resolveOffer('1', said), null, `"${said}" is not an answer`);
  }
}));

test('there is nothing to resolve without a pending offer', withDb(() => {
  seedCatalog();
  assert.equal(switching.resolveOffer('1', 'b'), null);
}));

test('an offer expires rather than lurking forever', withDb(() => {
  const options = offerFixture();
  const t0 = Date.now();
  assert.ok(switching.resolveOffer('1', 'a', { nowMs: t0 }));
  switching.offer('1', 'chat', options, { nowMs: t0 });
  assert.equal(switching.resolveOffer('1', 'a', { nowMs: t0 + switching.OFFER_TTL_MS + 1 }), null);
}));

test('applying an answer switches and says what it costs', withDb(() => {
  const options = offerFixture();
  const answer = switching.resolveOffer('1', 'a');
  const said = switching.applyAnswer('1', answer);
  assert.match(said, /Switched to/);
  assert.match(said, /credits per reply/);
  assert.equal(switching.currentModel('1', 'chat'), options[0].id);
  assert.equal(switching.pendingOffer('1'), null, 'the offer is consumed');
}));

test('the spoken offer names the dead backend and every option', withDb(() => {
  const options = offerFixture();
  const text = switching.offerText('openrouter/free', options);
  assert.match(text, /openrouter\/free/);
  assert.match(text, /rate limited/);
  for (const [i, option] of options.entries()) {
    assert.ok(text.includes(`${String.fromCharCode(65 + i)}: ${option.label}`));
  }
  assert.match(text, /switch back/);
}));
