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
    // The "song I just made" cache is module-level, keyed by guild id, and
    // every fakeMessage below shares guild id '1' — without this reset a
    // generate_music left pending by an earlier test leaks into the next.
    musicTools._resetForTests();
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

// ===========================================================================
// song library + voice playback
// ===========================================================================

/** A fake stand-in for voice.js's playback API, so these tests exercise
 * musicTools' own logic (what gets saved/found/queued) without driving a
 * real @discordjs/voice connection — the same reason voice.test.js itself
 * doesn't touch the AudioPlayer machinery directly. */
function fakeVoice({ connected = true, busy = false } = {}) {
  const played = [];
  let playing = false;
  return {
    played, // array of arrays of {title, data, mediaType} passed to playInVoice
    async playInVoice(guild, songs) {
      if (!connected || busy) return false;
      played.push(songs);
      playing = true;
      return true;
    },
    stopMusic() {
      const wasPlaying = playing;
      playing = false;
      return wasPlaying;
    },
  };
}

async function generateAndDiscard(message) {
  return withFetch(
    async () => sseResponse(musicChunk('CLIPBYTES')),
    () => musicTools.execute(null, message, 'generate_music', { prompt: 'a jingle' }, OWNER),
  );
}

test('save_song refuses when nothing was generated recently', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'save_song', { title: 'X' }, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /no recently generated song/);
}));

test('save_song needs a title', withDb(async () => {
  const message = fakeMessage(OWNER);
  await generateAndDiscard(message);
  const result = await musicTools.execute(null, message, 'save_song', {}, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /needs a title/);
}));

test('generate_music then save_song persists it, and list_songs shows it', withDb(async () => {
  const message = fakeMessage(OWNER);
  await generateAndDiscard(message);
  const saved = await musicTools.execute(null, message, 'save_song', { title: 'Chill Vibes' }, OWNER);
  assert.match(saved, /Saved "Chill Vibes"/);
  assert.equal(db.countSongs('1'), 1);

  const listed = await musicTools.execute(null, message, 'list_songs', {}, OWNER);
  assert.match(listed, /Chill Vibes/);
}));

test('save_song a second time without a fresh generation fails — no silent duplicate', withDb(async () => {
  const message = fakeMessage(OWNER);
  await generateAndDiscard(message);
  await musicTools.execute(null, message, 'save_song', { title: 'First Save' }, OWNER);
  const result = await musicTools.execute(null, message, 'save_song', { title: 'Second Save' }, OWNER);
  assert.match(result, /^Error:/);
  assert.equal(db.countSongs('1'), 1);
}));

test('save_song refuses once the library is full and names the current titles', withDb(async () => {
  const message = fakeMessage(OWNER);
  for (let i = 0; i < db.SONG_LIBRARY_CAP; i += 1) {
    db.addSong('1', {
      title: `Song ${i}`, prompt: 'p', data: Buffer.from('x'), mediaType: 'audio/mpeg',
      length: 'short', costUsd: 0, createdBy: OWNER,
    });
  }
  await generateAndDiscard(message);
  const result = await musicTools.execute(null, message, 'save_song', { title: 'One Too Many' }, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /full \(10\/10\)/);
  assert.match(result, /Song 0/);
  assert.equal(db.countSongs('1'), db.SONG_LIBRARY_CAP);
}));

test('list_songs reports an empty library plainly', withDb(async () => {
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'list_songs', {}, OWNER);
  assert.match(result, /empty/);
}));

test('delete_song removes a saved song by title', withDb(async () => {
  db.addSong('1', {
    title: 'Chill Vibes', prompt: 'p', data: Buffer.from('x'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'delete_song', { song: 'chill vibes' }, OWNER);
  assert.match(result, /Deleted "Chill Vibes"/);
  assert.equal(db.countSongs('1'), 0);
}));

test('delete_song reports an unmatched title without deleting anything', withDb(async () => {
  db.addSong('1', {
    title: 'Chill Vibes', prompt: 'p', data: Buffer.from('x'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  const result = await musicTools.execute(null, fakeMessage(OWNER), 'delete_song', { song: 'nope' }, OWNER);
  assert.match(result, /^Error:/);
  assert.equal(db.countSongs('1'), 1);
}));

test('play_song with no name plays the just-generated clip, not a saved one', withDb(async () => {
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const message = fakeMessage(OWNER);
    await generateAndDiscard(message);
    const result = await musicTools.execute(null, message, 'play_song', {}, OWNER);
    assert.match(result, /Now playing/);
    assert.equal(voice.played.length, 1);
    assert.equal(voice.played[0][0].data.toString(), 'CLIPBYTES');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song with no name and nothing generated is a clear error', withDb(async () => {
  musicTools._setVoiceModuleForTests(fakeVoice());
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', {}, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /nothing was generated recently/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song by title plays the saved song', withDb(async () => {
  db.addSong('1', {
    title: 'Chill Vibes', prompt: 'p', data: Buffer.from('SAVEDBYTES'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Chill Vibes' }, OWNER);
    assert.match(result, /Now playing "Chill Vibes"/);
    assert.equal(voice.played[0][0].data.toString(), 'SAVEDBYTES');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_song reports plainly when the bot is not connected to voice', withDb(async () => {
  db.addSong('1', {
    title: 'Chill Vibes', prompt: 'p', data: Buffer.from('x'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  musicTools._setVoiceModuleForTests(fakeVoice({ connected: false }));
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Chill Vibes' }, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /not in a voice channel/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_playlist queues every saved song in order', withDb(async () => {
  db.addSong('1', {
    title: 'First', prompt: 'p', data: Buffer.from('a'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  db.addSong('1', {
    title: 'Second', prompt: 'p', data: Buffer.from('b'), mediaType: 'audio/mpeg',
    length: 'short', costUsd: 0, createdBy: OWNER,
  });
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_playlist', {}, OWNER);
    assert.match(result, /2 song\(s\), starting with "First"/);
    assert.equal(voice.played[0].length, 2);
    assert.deepEqual(voice.played[0].map((s) => s.title), ['First', 'Second']);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('play_playlist refuses an empty library', withDb(async () => {
  musicTools._setVoiceModuleForTests(fakeVoice());
  try {
    const result = await musicTools.execute(null, fakeMessage(OWNER), 'play_playlist', {}, OWNER);
    assert.match(result, /^Error:/);
    assert.match(result, /library is empty/);
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('stop_music reports whether anything was actually stopped', withDb(async () => {
  const voice = fakeVoice();
  musicTools._setVoiceModuleForTests(voice);
  try {
    const nothing = await musicTools.execute(null, fakeMessage(OWNER), 'stop_music', {}, OWNER);
    assert.equal(nothing, 'Nothing was playing.');

    db.addSong('1', {
      title: 'Chill Vibes', prompt: 'p', data: Buffer.from('x'), mediaType: 'audio/mpeg',
      length: 'short', costUsd: 0, createdBy: OWNER,
    });
    await musicTools.execute(null, fakeMessage(OWNER), 'play_song', { song: 'Chill Vibes' }, OWNER);
    const stopped = await musicTools.execute(null, fakeMessage(OWNER), 'stop_music', {}, OWNER);
    assert.equal(stopped, 'Stopped the music.');
  } finally {
    musicTools._setVoiceModuleForTests(null);
  }
}));

test('song library tools are refused for a non-admin, same gate as generate_music', withDb(async () => {
  const message = fakeMessage('someone-else');
  const result = await musicTools.execute(null, message, 'list_songs', {}, OWNER);
  assert.match(result, /^Error:/);
  assert.match(result, /limited to server admins/);
}));
