// Music generation. music.js's HTTP goes through the global fetch, which is
// swapped for a fake here — same seam media.test.js uses — with a fake
// streamed body standing in for OpenRouter's SSE audio-output framing, since
// the sandbox's egress allowlist blocks OpenRouter anyway and these are
// about control flow: how SSE deltas become one audio Buffer, and who is
// allowed to spend money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionsBitField } from 'discord.js';
import * as db from '../src/db.js';
import * as music from '../src/music.js';
import * as musicTools from '../src/musicTools.js';

const OWNER = 'owner-1';

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = original; });
}

/** Fakes OpenRouter's streamed response: one "data: {...}\n\n" SSE chunk per
 * event, terminated by "data: [DONE]" — matches what music.js's reader loop
 * reads via getReader() (it splits on single newlines, so the blank line in
 * each "\n\n" here is just an extra empty line it skips over). */
function sseResponse(events) {
  const lines = [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), 'data: [DONE]\n\n'];
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i >= lines.length) return { done: true, value: undefined };
          const value = encoder.encode(lines[i]);
          i += 1;
          return { done: false, value };
        },
        releaseLock() {},
      }),
    },
  };
}

function errorResponse(body, status = 400) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

const audioChunk = (data, format) => ({ choices: [{ delta: { audio: { data, format } } }] });
const b64 = (text) => Buffer.from(text).toString('base64');

// ===========================================================================
// music.js
// ===========================================================================

test('decodes each audio delta on its own and concatenates the bytes', () => withFetch(
  // Verified against a working reference implementation: each delta.audio.data
  // chunk is its OWN independently base64-encoded (and independently padded)
  // fragment — decode every chunk separately, then concatenate the resulting
  // byte Buffers. Concatenating the base64 STRINGS first and decoding once
  // (the previous, unverified approach here) breaks the moment a chunk's
  // padding lands mid-stream, which is exactly what this fixture catches:
  // 'SONG' and 'BYTES' are each padded on their own, same as real chunks.
  async () => sseResponse([audioChunk(b64('SONG'), 'mp3'), audioChunk(b64('BYTES'))]),
  async () => {
    const clip = await music.generateMusic('a cheerful jingle');
    assert.ok(Buffer.isBuffer(clip.data));
    assert.equal(clip.data.toString(), 'SONGBYTES');
    assert.equal(clip.mediaType, 'audio/mpeg');
  },
));

test("length 'short' (default) uses the clip model, 'full' uses the pro model", () => {
  let sent = null;
  let sentHeaders = null;
  return withFetch(
    async (_url, opts) => {
      sent = JSON.parse(opts.body);
      sentHeaders = opts.headers;
      return sseResponse([audioChunk(b64('x'))]);
    },
    async () => {
      await music.generateMusic('a jingle');
      assert.equal(sent.model, 'google/lyria-3-clip-preview');
      assert.deepEqual(sent.modalities, ['text', 'audio']);
      assert.equal(sent.stream, true, 'OpenRouter rejects audio output without stream: true');
      assert.ok(sentHeaders['HTTP-Referer'], 'the reference implementation sends this on every audio-output call');

      await music.generateMusic('a full song', { length: 'full' });
      assert.equal(sent.model, 'google/lyria-3-pro-preview');
    },
  );
});

test('costUsd is read off a usage.cost field in the stream, 0 when absent', () => withFetch(
  async () => sseResponse([audioChunk(b64('x')), { usage: { cost: 0.04 } }]),
  async () => {
    const withCost = await music.generateMusic('a jingle');
    assert.equal(withCost.costUsd, 0.04);
    globalThis.fetch = async () => sseResponse([audioChunk(b64('x'))]);
    const withoutCost = await music.generateMusic('a jingle');
    assert.equal(withoutCost.costUsd, 0);
  },
));

test("a non-200 surfaces the API's own error message, not just the status", () => withFetch(
  async () => errorResponse({ error: { message: 'model overloaded' } }, 429),
  async () => {
    await assert.rejects(
      music.generateMusic('a jingle'),
      (err) => err instanceof music.MusicError && /429/.test(err.message) && /model overloaded/.test(err.message),
    );
  },
));

test('an error event mid-stream aborts with its message', () => withFetch(
  async () => sseResponse([audioChunk(b64('SO')), { error: { message: 'content policy violation' } }]),
  async () => {
    await assert.rejects(music.generateMusic('a jingle'), /content policy violation/);
  },
));

test('a stream that never carries audio is a MusicError', () => withFetch(
  async () => sseResponse([{ choices: [{ delta: {} }] }]),
  async () => {
    await assert.rejects(music.generateMusic('a jingle'), /returned no audio/);
  },
));

test('a blank prompt is rejected before any request goes out', () => {
  let calls = 0;
  return withFetch(
    async () => { calls += 1; return sseResponse([audioChunk(b64('x'))]); },
    async () => {
      await assert.rejects(music.generateMusic('   '), music.MusicError);
      await assert.rejects(music.generateMusic(''), /prompt is required/);
      assert.equal(calls, 0, 'a blank prompt must not cost a request');
    },
  );
});

// ===========================================================================
// musicTools.js
// ===========================================================================

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-music-test-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** A GuildMember with the given Discord permission flags — same shape
 * web.test.js's fakeMember uses for the same underlying roles.js check. */
function fakeMember(id, flags = []) {
  return {
    id,
    user: { id, username: `user-${id}` },
    roles: { cache: new Map() },
    permissions: { has: (flag) => flags.includes(flag) },
  };
}

/** Only the bits the handlers touch: .guild/.channel/.author/.member, same
 * relaxed message contract mediaTools' own tests use. */
function fakeMessage(authorId, { flags = [], inGuild = true } = {}) {
  const sent = [];
  const deleted = [];
  const member = inGuild ? fakeMember(authorId, flags) : null;
  return {
    guild: {
      id: '1',
      members: {
        cache: new Map(member ? [[authorId, member]] : []),
        fetch: async (id) => {
          const m = new Map(member ? [[authorId, member]] : []).get(id);
          if (!m) throw new Error('Unknown Member');
          return m;
        },
      },
    },
    author: { id: authorId },
    member,
    channel: {
      send: async (payload) => {
        sent.push(payload);
        const notice = { id: `msg-${sent.length}`, edit: async () => {}, delete: async () => { deleted.push(notice.id); } };
        return notice;
      },
    },
    _sent: sent,
    _deleted: deleted,
  };
}

// -- allowed ------------------------------------------------------------------

test('the bot owner may always generate music, even with no special roles', withDb(async () => {
  assert.equal(await musicTools.allowed(fakeMessage(OWNER, { flags: [] }), OWNER), true);
}));

test('Discord Administrator (which the server owner always has) is enough', withDb(async () => {
  const message = fakeMessage('someone-else', { flags: [PermissionsBitField.Flags.Administrator] });
  assert.equal(await musicTools.allowed(message, OWNER), true);
}));

test('a role mapped to dashboard_admin_roles is enough', withDb(async () => {
  db.setSetting('1', 'dashboard_admin_roles', ['admin-role']);
  const message = fakeMessage('someone-else');
  message.member.roles.cache = new Map([['admin-role', { id: 'admin-role' }]]);
  assert.equal(await musicTools.allowed(message, OWNER), true);
}));

test('a plain member is refused, even one with moderator permissions', withDb(async () => {
  const message = fakeMessage('someone-else', { flags: [PermissionsBitField.Flags.KickMembers] });
  assert.equal(await musicTools.allowed(message, OWNER), false);
}));

test('someone who is not a member of this guild at all is refused', withDb(async () => {
  const message = fakeMessage('someone-else', { inGuild: false });
  assert.equal(await musicTools.allowed(message, OWNER), false);
}));

// -- execute --------------------------------------------------------------------

const musicChunk = (bytes = 'SONGBYTES') => [audioChunk(Buffer.from(bytes).toString('base64'))];

test('execute re-checks access and refuses a non-admin without calling the API', withDb(async () => {
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return sseResponse(musicChunk()); },
    async () => {
      const message = fakeMessage('someone-else');
      const result = await musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.match(result, /^Error:/);
      assert.match(result, /limited to server admins, the server owner, or the bot owner/);
      assert.equal(calls, 0, 'a refused call must not reach the API');
      assert.equal(message._sent.length, 0);
    },
  );
}));

test('generate_music posts the file and reports it as already posted', withDb(async () => {
  await withFetch(
    async () => sseResponse(musicChunk()),
    async () => {
      const message = fakeMessage(OWNER);
      const result = await musicTools.execute(null, message, 'generate_music', { prompt: 'a cheerful jingle' }, OWNER);
      assert.equal(message._sent.length, 2, 'the working notice, then the file');
      const [file] = message._sent[1].files;
      assert.equal(file.attachment.toString(), 'SONGBYTES');
      assert.equal(file.name, 'generated_song.mp3');
      assert.match(result, /ALREADY POSTED/);
      assert.doesNotMatch(result, /^Error:/);
      assert.equal(message._deleted.length, 1, 'the working notice is cleaned up');
    },
  );
}));

test('an oversized track is not posted, and the result says so', withDb(async () => {
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41).toString('base64');
  await withFetch(
    async () => sseResponse([audioChunk(huge)]),
    async () => {
      const message = fakeMessage(OWNER);
      const result = await musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.equal(message._sent.length, 1, 'only the working notice, nothing uploaded');
      assert.match(result, /nothing was posted/);
      assert.match(result, /^Error:/);
    },
  );
}));

test('a MusicError comes back as an Error string instead of throwing', withDb(async () => {
  await withFetch(
    async () => errorResponse({ error: { message: 'model overloaded' } }, 429),
    async () => {
      const result = await musicTools.execute(null, fakeMessage(OWNER), 'generate_music', { prompt: 'a jingle' }, OWNER);
      assert.match(result, /^Error: /);
      assert.match(result, /model overloaded/);
    },
  );
}));

test('a blank prompt is a ToolError, surfaced as an Error string', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'generate_music', {}, OWNER);
  assert.match(result, /^Error: /);
  assert.match(result, /needs a prompt/);
}));
