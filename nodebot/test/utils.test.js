import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwner } from '../src/utils.js';

test('matches when userId equals the (injected) owner id', () => {
  assert.equal(isOwner('42', '42'), true);
  assert.equal(isOwner(42, '42'), true); // loose string compare either direction
  assert.equal(isOwner('99', '42'), false);
});

test('an unset owner id matches nobody, including an empty userId', () => {
  assert.equal(isOwner('', ''), false);
  assert.equal(isOwner('0', ''), false);
});

test('uses the real configured OWNER_ID by default when not injected', () => {
  // No .env in this environment, so OWNER_ID is unset — matches nobody.
  assert.equal(isOwner('anything'), false);
});
