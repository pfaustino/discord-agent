import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny } from '../src/voice.js';

test('matches a wake word inside a longer sentence', () => {
  assert.equal(matchesAny('hey max what do you think', ['hey max', 'hey andrew']), true);
});

test('is case-insensitive', () => {
  assert.equal(matchesAny('HEY MAX are you there', ['hey max']), true);
});

test('ignores punctuation between words', () => {
  assert.equal(matchesAny('hey, max! you around?', ['hey max']), true);
});

test('does not match when no phrase is present', () => {
  assert.equal(matchesAny('just chatting about lunch', ['hey max', 'hey andrew']), false);
});

test('empty word list never matches', () => {
  assert.equal(matchesAny('hey max', []), false);
});
