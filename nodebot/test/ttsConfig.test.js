import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { ttsConfigForGuild, ttsSettingsMeta } from '../src/ttsConfig.js';

const DB = ':memory:';

function withDb(fn) {
  return async () => {
    db.initDb(DB);
    try {
      await fn();
    } finally {
      db.closeDb();
    }
  };
}

afterEach(() => {
  try { db.closeDb(); } catch { /* already closed */ }
});

test('uses env defaults when no per-guild override is saved', withDb(() => {
  const cfg = ttsConfigForGuild('1');
  assert.ok(cfg.fishModel);
  assert.ok(cfg.edgeVoice);
}));

test('per-guild overrides win over env defaults', withDb(() => {
  db.setSetting('1', 'fish_voice_id', 'abc123');
  db.setSetting('1', 'fish_tts_model', 's2.1-pro');
  db.setSetting('1', 'edge_tts_voice', 'en-GB-SoniaNeural');
  const cfg = ttsConfigForGuild('1');
  assert.equal(cfg.fishVoiceId, 'abc123');
  assert.equal(cfg.fishModel, 's2.1-pro');
  assert.equal(cfg.edgeVoice, 'en-GB-SoniaNeural');
}));

test('blank overrides fall back to env', withDb(() => {
  db.setSetting('1', 'fish_voice_id', '   ');
  const cfg = ttsConfigForGuild('1');
  assert.notEqual(cfg.fishVoiceId, '   ');
}));

test('settings meta reports override vs env source', withDb(() => {
  db.setSetting('1', 'edge_tts_voice', 'en-US-AriaNeural');
  const meta = ttsSettingsMeta('1');
  assert.equal(meta.edge_tts_voice_effective, 'en-US-AriaNeural');
  assert.equal(meta.edge_tts_voice_source, 'override');
  assert.equal(meta.fish_tts_model_source, 'env');
}));

test('guilds are isolated', withDb(() => {
  db.setSetting('1', 'fish_voice_id', 'guild-one');
  const cfg2 = ttsConfigForGuild('2');
  assert.notEqual(cfg2.fishVoiceId, 'guild-one');
}));
