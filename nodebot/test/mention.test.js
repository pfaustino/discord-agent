// Stage 1 of smart detection. The classifier itself is an LLM call, so what
// is tested here is everything AROUND it: the local fast path, the parsing of
// whatever the model returns, the cost guards, and — most importantly — that
// a failing classifier degrades to "not mentioned" rather than taking voice
// down with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import {
  looksLikeMention, mightBeMention, nameForms, editDistance, parseVerdict,
  detectMention, resetCooldowns, CLASSIFY_COOLDOWN_MS,
} from '../src/mention.js';

const guildNamed = (name) => ({
  id: '1',
  client: { user: { displayName: name, username: name } },
});

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-test-'));
    db.initDb(path.join(dir, 'test.db'));
    resetCooldowns();
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// -- edit distance -----------------------------------------------------------

test('edit distance counts single edits and caps out', () => {
  assert.equal(editDistance('amy', 'amy'), 0);
  assert.equal(editDistance('amie', 'amy', 1), 2);   // over the cap, reported as cap+1
  assert.equal(editDistance('maxx', 'max', 1), 1);
  assert.equal(editDistance('completely', 'different', 2), 3);
});

// -- local fast path ---------------------------------------------------------

test('an exact name is a mention', () => {
  assert.ok(looksLikeMention('hey amy can you help', 'Amy'));
});

test('punctuation and capitals do not matter', () => {
  assert.ok(looksLikeMention('AMY! are you there?', 'Amy'));
});

test('a name inside a longer word is not a mention', () => {
  // Substring matching would fire on "amylase" — this is word-wise.
  assert.ok(!looksLikeMention('the amylase enzyme', 'Amy'));
});

test('short names get no fuzzy slack', () => {
  // "any" is one edit from "amy"; at three letters that is far too eager, and
  // the classifier is the right place to make that judgement instead.
  assert.ok(!looksLikeMention('any of them will do', 'Amy'));
});

test('longer names tolerate one typo', () => {
  assert.ok(!looksLikeMention('hey maxel', 'Maxwell'));
  assert.ok(looksLikeMention('hey maxwel', 'Maxwell'));
});

// -- given names -------------------------------------------------------------

test('a two-word display name also matches on the given name alone', () => {
  // The production case: the Discord display name was "Amy Smith", nobody
  // says that out loud, and matching only the full phrase meant the fast
  // path never fired once.
  assert.ok(looksLikeMention('hey amy you there', 'Amy Smith'));
  assert.ok(looksLikeMention('amy smith is the bot', 'Amy Smith'));
});

test('a surname alone is not treated as the name', () => {
  assert.ok(!looksLikeMention('smith was here', 'Amy Smith'));
});

test('name forms expose the full name and the given name', () => {
  assert.deepEqual(nameForms('Amy Smith').forms, ['amy smith', 'amy']);
  assert.deepEqual(nameForms('Amy').forms, ['amy']);
  assert.deepEqual(nameForms('\u{1F916}').forms, []);
});

// -- the local gate that keeps the classifier rare ---------------------------

test('ordinary speech with nothing name-shaped never reaches the model', () => {
  assert.ok(!mightBeMention('what time is the meeting tomorrow', 'Amy'));
  assert.ok(!mightBeMention('I pushed the branch already', 'Amy'));
});

test('a plausible mishearing does reach the model', () => {
  // The production case: "Amy" transcribed as two words.
  assert.ok(mightBeMention('hey aim ee are you there', 'Amy'));
  assert.ok(mightBeMention('hey emmy can you help', 'Amy'));
});

test('the gate admits short common words that share the name sound', () => {
  // "Amy" reduces to "m", so these get through and the classifier rejects
  // them. That asymmetry is deliberate: a false positive costs one cheap
  // call, a false negative costs an unanswered question.
  assert.ok(mightBeMention('am i on mute', 'Amy'));
  assert.ok(mightBeMention('is that my problem', 'Amy'));
});

test('a different consonant is rejected without a model call', () => {
  // "any" sounds like "EN-ee", not "AY-mee" — different consonant, so it
  // never reaches the classifier. An m/n mishearing is possible in principle
  // and this gives it up on purpose: "any" is far too common a word to spend
  // a call on every time it is said.
  assert.ok(!mightBeMention('any of them will do', 'Amy'));
});

test('the gate follows the given name of a two-word name', () => {
  assert.ok(mightBeMention('hey aim ee', 'Amy Smith'));
});

test('multi-word names match on the full phrase and on the given name', () => {
  assert.ok(looksLikeMention('ok max bot do the thing', 'Max Bot'));
  // The given name alone counts — this is how people actually address it.
  assert.ok(looksLikeMention('ok max do the thing', 'Max Bot'));
});

test('an empty name never matches', () => {
  assert.ok(!looksLikeMention('anything at all', ''));
  assert.ok(!looksLikeMention('anything at all', '🤖'));
});

// -- verdict parsing ---------------------------------------------------------

test('a clean JSON verdict parses', () => {
  assert.deepEqual(parseVerdict('{"mentioned": true, "heard": "aim ee"}'),
    { mentioned: true, heard: 'aim ee' });
});

test('a fenced verdict parses', () => {
  assert.deepEqual(parseVerdict('```json\n{"mentioned": false, "heard": ""}\n```'),
    { mentioned: false, heard: '' });
});

test('a chatty verdict still parses', () => {
  assert.equal(parseVerdict('Sure! {"mentioned": true, "heard": "amy"} hope that helps')?.mentioned,
    true);
});

test('a reasoning model that narrates before answering still parses', () => {
  // The exact production failure: 60 max_tokens went entirely on thinking.
  const reply = 'The user wants me to act as a pre-filter for a Discord voice '
    + 'bot named "Amy Smith". The latest line sounds like Amy.' + '\n'
    + 'HEARD: aim ee' + '\n' + 'ANSWER: YES';
  assert.deepEqual(parseVerdict(reply), { mentioned: true, heard: 'aim ee' });
});

test('the last answer wins when a model changes its mind mid-thought', () => {
  const reply = 'At first ANSWER: YES seems right, but that is an ordinary word.'
    + '\n' + 'HEARD: NONE' + '\n' + 'ANSWER: NO';
  assert.deepEqual(parseVerdict(reply), { mentioned: false, heard: '' });
});

test('HEARD: NONE means nothing was heard, not the literal word', () => {
  assert.equal(parseVerdict('HEARD: NONE' + '\n' + 'ANSWER: NO').heard, '');
});

test('a bare yes or no is accepted', () => {
  assert.equal(parseVerdict('YES').mentioned, true);
  assert.equal(parseVerdict('no.').mentioned, false);
});

test('an empty reply is null, not a silent false', () => {
  // Empty was the other half of the production failure, and must stay visible
  // in the logs rather than looking like a confident "not mentioned".
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('   '), null);
});

test('junk and missing fields parse to null rather than a false positive', () => {
  assert.equal(parseVerdict('no idea'), null);
  assert.equal(parseVerdict('{"heard": "amy"}'), null);
  assert.equal(parseVerdict('{"mentioned": "yes"}'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict(null), null);
});

// -- orchestration -----------------------------------------------------------

test('the fast path answers without any model call', withDb(async () => {
  // No OPENROUTER call is possible in tests; reaching one would throw or hang,
  // so returning via 'name' is itself the assertion that none was made.
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'hey amy you around');
  assert.deepEqual(verdict, { mentioned: true, via: 'name' });
}));

test('a one-word utterance is not worth a model call', withDb(async () => {
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'yeah');
  assert.deepEqual(verdict, { mentioned: false, via: 'none' });
}));

test('a very long utterance is not worth a model call', withDb(async () => {
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'word '.repeat(200));
  assert.deepEqual(verdict, { mentioned: false, via: 'none' });
}));

test('a classifier failure degrades to not-mentioned', withDb(async () => {
  // OPENROUTER_API_KEY is a dummy in tests, so the call fails — the point is
  // that voice keeps working rather than an exception escaping into the
  // audio pipeline. "am i" is name-shaped enough to get past the local gate.
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'am i on mute again');
  assert.equal(verdict.mentioned, false);
  assert.ok(['none', 'skipped'].includes(verdict.via));
}));

test('speech with no name-shaped word never spends budget', withDb(async () => {
  // The regression that took out memory consolidation: every utterance
  // reached the model, and a busy channel drained the shared hourly pool.
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'what time is the meeting');
  assert.deepEqual(verdict, { mentioned: false, via: 'no-candidate' });
}));

test('the per-channel cooldown suppresses a rapid second classify', withDb(async () => {
  const guild = guildNamed('Amy');
  const now = 1_000_000;
  await detectMention(guild, 'c1', 'am i on mute', { now });
  const second = await detectMention(guild, 'c1', 'am i still here', { now: now + 100 });
  assert.equal(second.via, 'skipped');
  // A different channel has its own budget.
  const other = await detectMention(guild, 'c2', 'am i still here', { now: now + 100 });
  assert.notEqual(other.via, 'skipped');
}));

test('the cooldown lapses', withDb(async () => {
  const guild = guildNamed('Amy');
  const now = 2_000_000;
  await detectMention(guild, 'c1', 'am i on mute', { now });
  const later = await detectMention(guild, 'c1', 'am i still here',
    { now: now + CLASSIFY_COOLDOWN_MS + 1 });
  assert.notEqual(later.via, 'skipped');
}));

test('the fast path is never blocked by the cooldown', withDb(async () => {
  // Someone plainly saying the name must always get through, even in a room
  // busy enough to be rate-limiting the classifier.
  const guild = guildNamed('Amy');
  const now = 3_000_000;
  await detectMention(guild, 'c1', 'am i on mute', { now });
  const direct = await detectMention(guild, 'c1', 'amy what do you think', { now: now + 10 });
  assert.deepEqual(direct, { mentioned: true, via: 'name' });
}));

test('the name comes from the bot_name override when set', withDb(async () => {
  db.setSetting('1', 'bot_name', 'Pixel');
  const verdict = await detectMention(guildNamed('Amy'), 'c1', 'hey pixel you there');
  assert.deepEqual(verdict, { mentioned: true, via: 'name' });
}));
