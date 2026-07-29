import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVoiceTags, isS2 } from '../src/tts.js';

test('strips S1 parenthesis emotion tags', () => {
  assert.equal(stripVoiceTags('(excited) lets go! (chuckling) nice'), 'lets go! nice');
});

test('strips S2 free-form bracket tags', () => {
  assert.equal(stripVoiceTags('[relaxed] all good [laughing nervously] for real'), 'all good for real');
});

test('leaves plain text with no tags untouched', () => {
  assert.equal(stripVoiceTags('just a normal reply'), 'just a normal reply');
});

test('does not strip parentheses that are not a recognized tag', () => {
  assert.equal(stripVoiceTags('check the repo (main branch) please'), 'check the repo (main branch) please');
});

test('isS2 is true for the default FISH_TTS_MODEL (s2.1-pro-free)', () => {
  // config.js's default is 's2.1-pro-free' when FISH_TTS_MODEL isn't set,
  // which starts with "s2" — this locks that default in place.
  assert.equal(isS2(), true);
});
