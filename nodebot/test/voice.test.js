import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny, describeToolCalls } from '../src/voice.js';

function toolCall(name, args) {
  return { function: { name, arguments: JSON.stringify(args) } };
}

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

test('describeToolCalls produces a known blurb for a recognized tool', () => {
  const blurb = describeToolCalls([toolCall('kick_member', { user: 'alice' })]);
  assert.equal(blurb, 'on it — kicking alice.');
});

test('describeToolCalls joins multiple calls with "then"', () => {
  const blurb = describeToolCalls([
    toolCall('kick_member', { user: 'alice' }),
    toolCall('send_message', { channel: 'general' }),
  ]);
  assert.equal(blurb, 'on it — kicking alice, then posting that in #general.');
});

test('describeToolCalls falls back to "handling that" for an unrecognized tool', () => {
  const blurb = describeToolCalls([toolCall('some_future_tool', {})]);
  assert.equal(blurb, 'on it — handling that.');
});

test('describeToolCalls survives malformed argument JSON from the model', () => {
  const blurb = describeToolCalls([{ function: { name: 'kick_member', arguments: 'not json' } }]);
  assert.equal(blurb, 'on it — kicking undefined.');
});

test('describeToolCalls with no calls at all', () => {
  assert.equal(describeToolCalls([]), 'on it, one sec.');
});
