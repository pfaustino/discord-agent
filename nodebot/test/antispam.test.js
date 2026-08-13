import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import { recordAndCheck, checkMessage, _resetForTests } from '../src/antispam.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-antispam-test-'));
    db.initDb(path.join(dir, 'test.db'));
    _resetForTests();
    try {
      await fn();
    } finally {
      db.closeDb();
      _resetForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('recordAndCheck ignores messages with no text and no attachments', withDb(() => {
  assert.equal(recordAndCheck('g', 'u', 'c1', '', false), null);
  assert.equal(recordAndCheck('g', 'u', 'c1', '   ', false), null);
}));

test('recordAndCheck does not trigger below the channel threshold', withDb(() => {
  const opts = { channelThreshold: 4, windowSeconds: 20 };
  let r;
  r = recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1000);
  assert.equal(r.triggered, false);
  assert.equal(r.channelCount, 1);
  r = recordAndCheck('g', 'u', 'c2', 'buy now', false, opts, 1500);
  assert.equal(r.triggered, false);
  assert.equal(r.channelCount, 2);
}));

test('recordAndCheck triggers once the same message hits enough distinct channels', withDb(() => {
  const opts = { channelThreshold: 4, windowSeconds: 20 };
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1000);
  recordAndCheck('g', 'u', 'c2', 'buy now', false, opts, 1200);
  recordAndCheck('g', 'u', 'c3', 'buy now', false, opts, 1400);
  const r = recordAndCheck('g', 'u', 'c4', 'buy now', false, opts, 1600);
  assert.equal(r.triggered, true);
  assert.equal(r.channelCount, 4);
}));

test('recordAndCheck does not count the same channel twice toward the threshold', withDb(() => {
  const opts = { channelThreshold: 3, windowSeconds: 20 };
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1000);
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1100); // same channel again
  const r = recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1200);
  assert.equal(r.triggered, false);
  assert.equal(r.channelCount, 1);
}));

test('recordAndCheck resets the tally once the window elapses', withDb(() => {
  const opts = { channelThreshold: 3, windowSeconds: 10 };
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 0);
  recordAndCheck('g', 'u', 'c2', 'buy now', false, opts, 5000);
  const r = recordAndCheck('g', 'u', 'c3', 'buy now', false, opts, 20000); // 20s later, outside window
  assert.equal(r.triggered, false);
  assert.equal(r.channelCount, 1);
}));

test('recordAndCheck resets the tally when the message content changes', withDb(() => {
  const opts = { channelThreshold: 3, windowSeconds: 20 };
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1000);
  recordAndCheck('g', 'u', 'c2', 'buy now', false, opts, 1100);
  const r = recordAndCheck('g', 'u', 'c3', 'something unrelated', false, opts, 1200);
  assert.equal(r.triggered, false);
  assert.equal(r.channelCount, 1);
}));

test('recordAndCheck is case/whitespace-insensitive and separates by attachment presence', withDb(() => {
  const opts = { channelThreshold: 2, windowSeconds: 20 };
  recordAndCheck('g', 'u', 'c1', '  Buy   NOW  ', false, opts, 1000);
  const r1 = recordAndCheck('g', 'u', 'c2', 'buy now', false, opts, 1100);
  assert.equal(r1.triggered, true);

  _resetForTests();
  recordAndCheck('g', 'u', 'c1', 'buy now', false, opts, 1000);
  const r2 = recordAndCheck('g', 'u', 'c2', 'buy now', true, opts, 1100); // now with an attachment
  assert.equal(r2.triggered, false); // different key, tally restarted
}));

test('recordAndCheck tracks different guilds and users independently', withDb(() => {
  const opts = { channelThreshold: 2, windowSeconds: 20 };
  recordAndCheck('g1', 'u1', 'c1', 'buy now', false, opts, 1000);
  recordAndCheck('g2', 'u1', 'c1', 'buy now', false, opts, 1000);
  recordAndCheck('g1', 'u2', 'c1', 'buy now', false, opts, 1000);
  const r = recordAndCheck('g1', 'u1', 'c2', 'buy now', false, opts, 1100);
  assert.equal(r.triggered, true); // only g1/u1 has hit two channels
}));

function makeMessage({ guildId = '1', authorId = '42', bot = false, hasManageMessages = false,
  content = 'buy now', channelId = 'c1', bannable = true } = {}) {
  return {
    guild: { id: guildId },
    author: { bot, id: authorId, tag: `user#${authorId}` },
    member: {
      permissions: { has: () => hasManageMessages },
      bannable,
      ban: async () => {},
    },
    channel: { id: channelId },
    content,
    attachments: { size: 0 },
  };
}

test('checkMessage does nothing when antispam is disabled', withDb(async () => {
  db.setSetting('1', 'antispam_enabled', false);
  db.setSetting('1', 'antispam_channel_threshold', 2);
  await checkMessage(makeMessage({ channelId: 'c1' }));
  await checkMessage(makeMessage({ channelId: 'c2' }));
  assert.equal(db.getLogs('1').length, 0);
}));

test('checkMessage skips bots, DMs, and staff', withDb(async () => {
  db.setSetting('1', 'antispam_enabled', true);
  db.setSetting('1', 'antispam_channel_threshold', 2);
  await checkMessage({ guild: null, author: { bot: false } });
  await checkMessage({ guild: { id: '1' }, author: { bot: true } });
  await checkMessage(makeMessage({ hasManageMessages: true, channelId: 'c1' }));
  await checkMessage(makeMessage({ hasManageMessages: true, channelId: 'c2' }));
  assert.equal(db.getLogs('1').length, 0);
}));

test('checkMessage bans and logs once the threshold is crossed', withDb(async () => {
  db.setSetting('1', 'antispam_enabled', true);
  db.setSetting('1', 'antispam_channel_threshold', 3);
  db.setSetting('1', 'antispam_window_seconds', 20);
  db.setSetting('1', 'antispam_delete_seconds', 3600);
  let banArgs = null;
  const banningMember = {
    permissions: { has: () => false },
    bannable: true,
    ban: async (args) => { banArgs = args; },
  };
  for (const channelId of ['c1', 'c2', 'c3']) {
    await checkMessage({
      guild: { id: '1' },
      author: { bot: false, id: '42', tag: 'spammer#42' },
      member: banningMember,
      channel: { id: channelId },
      content: 'free nitro, click here',
      attachments: { size: 0 },
    });
  }
  assert.ok(banArgs, 'ban() should have been called');
  assert.equal(banArgs.deleteMessageSeconds, 3600);
  assert.match(banArgs.reason, /3 channels/);
  const logs = db.getLogs('1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'antispam_ban');
}));

test('checkMessage logs a flag instead of banning when the bot cannot ban the member', withDb(async () => {
  db.setSetting('1', 'antispam_enabled', true);
  db.setSetting('1', 'antispam_channel_threshold', 2);
  let banCalled = false;
  const unbannableMember = {
    permissions: { has: () => false },
    bannable: false,
    ban: async () => { banCalled = true; },
  };
  for (const channelId of ['c1', 'c2']) {
    await checkMessage({
      guild: { id: '1' },
      author: { bot: false, id: '42', tag: 'spammer#42' },
      member: unbannableMember,
      channel: { id: channelId },
      content: 'free nitro',
      attachments: { size: 0 },
    });
  }
  assert.equal(banCalled, false);
  const logs = db.getLogs('1');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'antispam_flag');
}));
