// Image generation. media.js's HTTP goes through the global fetch, which is
// swapped for a fake here (same seam openrouter.test.js uses) — the
// sandbox's egress allowlist blocks OpenRouter anyway, and these are about
// control flow: how a b64 payload becomes a Buffer, and who is allowed to
// spend money.
//
// mediaTools tests drive media.js end to end through that same fake fetch
// rather than stubbing it: `import * as media` gives mediaTools a frozen
// namespace object, so the exports can't be reassigned from a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as db from '../src/db.js';
import * as media from '../src/media.js';
import * as mediaTools from '../src/mediaTools.js';
import * as documents from '../src/documents.js';
import { stripImageParts } from '../src/openrouter.js';
import { modelForTurn } from '../src/textChat.js';

const OWNER = 'owner-1';
const GUILD = '1'; // matches fakeMessage's guild id

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = original; });
}

/** Stands in for a discord.js Attachment — same fake documents.test.js uses.
 * read() is the seam that keeps these off the network. */
function fakeAttachment(name, data, contentType = null) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { name, size: buf.length, contentType, read: async () => buf };
}

const b64 = (text) => Buffer.from(text).toString('base64');

// ===========================================================================
// media.js — generateImage
// ===========================================================================

test('decodes b64_json into a Buffer with the reported media type', () => withFetch(
  async () => jsonResponse({ data: [{ b64_json: b64('PNGBYTES'), media_type: 'image/webp' }] }),
  async () => {
    const { images } = await media.generateImage('a cat');
    assert.equal(images.length, 1);
    assert.ok(Buffer.isBuffer(images[0].data));
    assert.equal(images[0].data.toString(), 'PNGBYTES');
    assert.equal(images[0].mediaType, 'image/webp');
  },
));

test('media type falls back to image/png when the API omits it', () => withFetch(
  async () => jsonResponse({ data: [{ b64_json: b64('x') }] }),
  async () => {
    const { images } = await media.generateImage('a cat');
    assert.equal(images[0].mediaType, 'image/png');
  },
));

test('costUsd reflects OpenRouter usage.cost, and 0 when the API omits it', () => withFetch(
  async () => jsonResponse({ data: [{ b64_json: b64('x') }], usage: { cost: 0.0042 } }),
  async () => {
    const withCost = await media.generateImage('a cat');
    assert.equal(withCost.costUsd, 0.0042);
    globalThis.fetch = async () => jsonResponse({ data: [{ b64_json: b64('x') }] });
    const withoutCost = await media.generateImage('a cat');
    assert.equal(withoutCost.costUsd, 0);
  },
));

test('n is clamped to IMAGE_MAX_N rather than forwarded as asked', () => {
  let sent = null;
  return withFetch(
    async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return jsonResponse({ data: [{ b64_json: b64('x') }] });
    },
    async () => {
      await media.generateImage('a cat', { n: 99 });
      assert.equal(sent.n, media.IMAGE_MAX_N);
      await media.generateImage('a cat', { n: 0 });
      assert.equal(sent.n, 1, 'a nonsense n floors at 1, not 0');
      await media.generateImage('a cat', { n: 2, aspectRatio: '16:9' });
      assert.equal(sent.n, 2);
      assert.equal(sent.aspect_ratio, '16:9');
    },
  );
});

test("a non-200 surfaces the API's own error message, not just the status", () => withFetch(
  async () => jsonResponse({ error: { message: 'content policy violation' } }, 400),
  async () => {
    await assert.rejects(
      media.generateImage('a cat'),
      (err) => err instanceof media.MediaError
        && /400/.test(err.message)
        && /content policy violation/.test(err.message),
    );
  },
));

test('an empty data array is a MediaError, not an empty result', () => withFetch(
  async () => jsonResponse({ data: [] }),
  async () => {
    await assert.rejects(media.generateImage('a cat'), media.MediaError);
  },
));

test('data entries with no b64_json count as no image', () => withFetch(
  async () => jsonResponse({ data: [{ revised_prompt: 'nope' }] }),
  async () => {
    await assert.rejects(media.generateImage('a cat'), /returned no image/);
  },
));

test('a blank prompt is rejected before any request goes out', () => {
  let calls = 0;
  return withFetch(
    async () => { calls += 1; return jsonResponse({ data: [] }); },
    async () => {
      await assert.rejects(media.generateImage('   '), media.MediaError);
      await assert.rejects(media.generateImage(''), /prompt is required/);
      assert.equal(calls, 0, 'a blank prompt must not cost a request');
    },
  );
});

// ===========================================================================
// mediaTools.js
// ===========================================================================
//
// generate_video's own script/image/narration/assembly logic lives in
// videomaker.js and is covered end-to-end there with injectable fakes for
// the pieces that aren't fetch-based (narration, ffmpeg). What's left to
// test here is what this file is actually responsible for: access control,
// the spend/time breaker, and the Discord-side wiring (notice posted, then
// cleaned up either way) — exercised through a real script-generation
// failure, since that's the one stage reachable through the fetch fake
// before anything touches TTS or ffmpeg.

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-media-test-'));
    db.initDb(path.join(dir, 'test.db'));
    mediaTools._videoCalls.clear(); // module-level breaker state leaks between tests
    try {
      await fn();
    } finally {
      mediaTools._videoCalls.clear();
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Only the bits the handlers touch: .guild/.channel/.author, same relaxed
 * message contract agentTools uses. */
function fakeMessage(authorId = OWNER, { premiumTier = 0 } = {}) {
  const sent = [];
  const deleted = [];
  return {
    guild: { id: '1', premiumTier },
    author: { id: authorId },
    channel: {
      send: async (payload) => {
        sent.push(payload);
        const notice = {
          id: `msg-${sent.length}`,
          edit: async () => {},
          delete: async () => { deleted.push(notice.id); },
        };
        return notice;
      },
    },
    _sent: sent,
    _deleted: deleted,
  };
}

const imageBody = (bytes = 'PNGBYTES', mediaType = 'image/png') => ({
  data: [{ b64_json: Buffer.from(bytes).toString('base64'), media_type: mediaType }],
});

// -- allowed ----------------------------------------------------------------

test('the owner may generate media by default', withDb(async () => {
  assert.equal(await mediaTools.allowed(fakeMessage(OWNER), OWNER), true);
}));

test('a non-owner may not, by default', withDb(async () => {
  assert.equal(await mediaTools.allowed(fakeMessage('someone-else'), OWNER), false);
}));

test("media_access 'everyone' opens it up to a non-owner", withDb(async () => {
  db.setSetting('1', 'media_access', 'everyone');
  assert.equal(await mediaTools.allowed(fakeMessage('someone-else'), OWNER), true);
}));

test('media_enabled false switches it off even for the owner', withDb(async () => {
  db.setSetting('1', 'media_enabled', false);
  assert.equal(await mediaTools.allowed(fakeMessage(OWNER), OWNER), false);
  // and the everyone escape hatch does not reopen it
  db.setSetting('1', 'media_access', 'everyone');
  assert.equal(await mediaTools.allowed(fakeMessage(OWNER), OWNER), false);
}));

// -- execute ----------------------------------------------------------------

test('execute re-checks access and refuses a non-owner without calling the API', withDb(async () => {
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return jsonResponse(imageBody()); },
    async () => {
      const message = fakeMessage('someone-else');
      const result = await mediaTools.execute(
        null, message, 'generate_image', { prompt: 'a cat' }, OWNER,
      );
      assert.match(result, /^Error:/);
      assert.match(result, /disabled in this server, or limited to the bot owner/);
      assert.equal(calls, 0, 'a refused call must not reach the API');
      assert.equal(message._sent.length, 0);
    },
  );
}));

test('generate_image posts the file and reports it as already posted', withDb(async () => {
  await withFetch(
    async () => jsonResponse(imageBody('PNGBYTES', 'image/jpeg')),
    async () => {
      const message = fakeMessage();
      const result = await mediaTools.execute(
        null, message, 'generate_image', { prompt: 'a cat in a hat' }, OWNER,
      );
      assert.equal(message._sent.length, 1);
      const [file] = message._sent[0].files;
      assert.equal(file.attachment.toString(), 'PNGBYTES');
      assert.equal(file.name, 'generated_1.jpg', 'jpeg maps to .jpg, not .jpeg');
      assert.match(result, /ALREADY POSTED/);
      assert.doesNotMatch(result, /^Error:/);
    },
  );
}));

test('an oversized image is not posted, and the result says so', withDb(async () => {
  // Unboosted guilds cap attachments at 10 MiB; premiumTier 0 is the fallback.
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
  await withFetch(
    async () => jsonResponse({ data: [{ b64_json: huge.toString('base64') }] }),
    async () => {
      const message = fakeMessage(OWNER, { premiumTier: 0 });
      const result = await mediaTools.execute(
        null, message, 'generate_image', { prompt: 'a cat' }, OWNER,
      );
      assert.equal(message._sent.length, 0, 'nothing should have been uploaded');
      assert.match(result, /nothing was posted/);
      assert.match(result, /^Error:/);
    },
  );
}));

test('a MediaError comes back as an Error string instead of throwing', withDb(async () => {
  await withFetch(
    async () => jsonResponse({ error: { message: 'content policy violation' } }, 400),
    async () => {
      const result = await mediaTools.execute(
        null, fakeMessage(), 'generate_image', { prompt: 'a cat' }, OWNER,
      );
      assert.match(result, /^Error: /);
      assert.match(result, /content policy violation/);
    },
  );
}));

test('a missing prompt is a ToolError string, not a thrown exception', withDb(async () => {
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return jsonResponse(imageBody()); },
    async () => {
      const result = await mediaTools.execute(null, fakeMessage(), 'generate_image', {}, OWNER);
      assert.match(result, /^Error: .*needs a prompt/);
      assert.equal(calls, 0);
    },
  );
}));

test('an unknown tool name is reported, not run', withDb(async () => {
  const result = await mediaTools.execute(null, fakeMessage(), 'generate_hologram', {}, OWNER);
  assert.match(result, /unknown tool/);
}));

// -- video: the hourly breaker, in isolation ---------------------------------
//
// takeVideoSlot is pure state-tracking (no HTTP), so it's tested directly
// here as well as indirectly further down through execute().

test('takeVideoSlot refuses past the limit, and a cap of 0 is unlimited', () => {
  mediaTools._videoCalls.clear();
  try {
    let now = 0;
    mediaTools.takeVideoSlot('1', 1, now);
    assert.throws(
      () => mediaTools.takeVideoSlot('1', 1, now),
      (err) => /cap/.test(err.message) && /minute/.test(err.message),
    );
    // a different guild has its own slot
    mediaTools.takeVideoSlot('2', 1, now);
    // an hour later the slot is free again
    now += 60 * 60_000 + 1;
    mediaTools.takeVideoSlot('1', 1, now);
    // cap 0 never refuses, however many calls
    for (let i = 0; i < 5; i += 1) mediaTools.takeVideoSlot('3', 0, now);
  } finally {
    mediaTools._videoCalls.clear();
  }
});

// -- video: a missing topic never touches the network or the breaker --------

test('a missing topic is a ToolError string, and never claims a video slot', withDb(async () => {
  const result = await mediaTools.execute(null, fakeMessage(), 'generate_video', {}, OWNER);
  assert.match(result, /^Error: .*needs a topic/);
  // slot not consumed: a cap of 1 still has room afterward
  db.setSetting('1', 'media_video_hourly_cap', 1);
  await withFetch(
    async () => jsonResponse({ error: { message: 'boom' } }, 500),
    async () => {
      const second = await mediaTools.execute(
        null, fakeMessage(), 'generate_video', { topic: 'cats' }, OWNER,
      );
      assert.doesNotMatch(second, /cap/);
    },
  );
}));

// -- video: the Discord-side wiring, through a real script failure ----------
//
// A script-generation failure is fetch-based (unlike narration or ffmpeg),
// so it's the one full-stack failure reachable here without faking anything
// videomaker.js itself doesn't already fake internally.

test('the status notice is posted, then cleaned up, when script generation fails', withDb(async () => {
  await withFetch(
    async () => jsonResponse({ error: { message: 'model unavailable' } }, 503),
    async () => {
      const message = fakeMessage();
      const result = await mediaTools.execute(
        null, message, 'generate_video', { topic: 'cats through history' }, OWNER,
      );
      assert.match(result, /^Error: /);
      assert.match(result, /model unavailable/);
      assert.equal(message._sent.length, 1, 'only the status notice, no clip');
      assert.match(String(message._sent[0]), /writing the script/);
      assert.deepEqual(message._deleted, ['msg-1'], 'the notice must not be left behind on failure');
    },
  );
}));

test('the hourly video cap refuses past the limit without posting a notice', withDb(async () => {
  db.setSetting('1', 'media_video_hourly_cap', 1);
  await withFetch(
    async () => jsonResponse({ error: { message: 'boom' } }, 500),
    async () => {
      const message = fakeMessage();
      await mediaTools.execute(null, message, 'generate_video', { topic: 'cats' }, OWNER);
      const afterFirst = message._sent.length;
      assert.ok(afterFirst > 0, 'the first attempt should have posted a notice');

      const second = await mediaTools.execute(
        null, message, 'generate_video', { topic: 'cats again' }, OWNER,
      );
      assert.match(second, /^Error: /);
      assert.match(second, /cap/);
      assert.equal(message._sent.length, afterFirst, 'the refused attempt must not post anything');
    },
  );
}));

test('every registered tool has a schema of the same name as its required params', () => {
  const configured = mediaTools.TOOL_SCHEMAS.map((s) => s.function.name).sort();
  assert.deepEqual(configured, ['generate_image', 'generate_video']);
  const byName = Object.fromEntries(mediaTools.TOOL_SCHEMAS.map((s) => [s.function.name, s]));
  assert.ok(byName.generate_image.function.parameters.required.includes('prompt'));
  assert.ok(byName.generate_video.function.parameters.required.includes('topic'));
});

// ===========================================================================
// documents.js — buildImageParts
// ===========================================================================

const png = (bytes = '\x89PNGdata') => fakeAttachment('shot.png', bytes, 'image/png');

test('an image becomes a base64 data-url part with a matching note', async () => {
  const { parts, notes } = await documents.buildImageParts({ attachments: [png()] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'image_url');
  assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(
    parts[0].image_url.url,
    `data:image/png;base64,${Buffer.from('\x89PNGdata').toString('base64')}`,
  );
  assert.deepEqual(notes, ['[attached image: shot.png]']);
});

test('the media type is inferred from the extension when contentType is absent', async () => {
  const { parts } = await documents.buildImageParts({
    attachments: [fakeAttachment('photo.jpeg', 'JPEGDATA', null)],
  });
  assert.match(parts[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test("Discord's declared content type wins over a misleading extension", async () => {
  const { parts } = await documents.buildImageParts({
    attachments: [fakeAttachment('photo.png', 'JPEGDATA', 'image/jpeg; charset=binary')],
  });
  assert.match(parts[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test('a non-image attachment produces nothing at all', async () => {
  const result = await documents.buildImageParts({
    attachments: [fakeAttachment('notes.txt', 'hello', 'text/plain')],
  });
  assert.deepEqual(result, { parts: [], notes: [] });
});

test('an unsupported image type is dropped rather than sent through', async () => {
  const tiff = await documents.buildImageParts({
    attachments: [fakeAttachment('scan.tiff', 'IIdata', 'image/tiff')],
  });
  assert.deepEqual(tiff, { parts: [], notes: [] });
  // and with no content type either, so the extension is all there is to go on
  const bare = await documents.buildImageParts({
    attachments: [fakeAttachment('scan.tiff', 'IIdata', null)],
  });
  assert.deepEqual(bare, { parts: [], notes: [] });
});

test('an oversized image is noted but never sent', async () => {
  const attachment = png();
  attachment.size = documents.MAX_IMAGE_BYTES + 1;
  const { parts, notes } = await documents.buildImageParts({ attachments: [attachment] });
  assert.equal(parts.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /too large to look at/);
  assert.match(notes[0], /shot\.png/);
});

test('images past the per-message cap are reported, not silently dropped', async () => {
  const attachments = Array.from(
    { length: documents.MAX_IMAGES + 2 },
    (_, i) => fakeAttachment(`img${i}.png`, `data${i}`, 'image/png'),
  );
  const { parts, notes } = await documents.buildImageParts({ attachments });
  assert.equal(parts.length, documents.MAX_IMAGES);
  assert.equal(notes.at(-1), `[2 more image(s) not shown — max ${documents.MAX_IMAGES} per message]`);
});

test('a failed image download is noted, not thrown', async () => {
  const { parts, notes } = await documents.buildImageParts({
    attachments: [{
      name: 'gone.png',
      size: 10,
      contentType: 'image/png',
      read: async () => { throw new Error('404'); },
    }],
  });
  assert.equal(parts.length, 0);
  assert.match(notes[0], /Couldn't download gone\.png/);
});

test('accepts a discord.js Collection of attachments, not just an array', async () => {
  const collection = new Map([['1', png()]]);
  const { parts } = await documents.buildImageParts({ attachments: collection });
  assert.equal(parts.length, 1);
});

test('imageMediaType recognises the four types vision models accept', () => {
  assert.equal(documents.imageMediaType(fakeAttachment('a.png', 'x', 'image/png')), 'image/png');
  assert.equal(documents.imageMediaType(fakeAttachment('a.jpg', 'x')), 'image/jpeg');
  assert.equal(documents.imageMediaType(fakeAttachment('a.webp', 'x')), 'image/webp');
  assert.equal(documents.imageMediaType(fakeAttachment('a.gif', 'x')), 'image/gif');
  assert.equal(documents.imageMediaType(fakeAttachment('a.bmp', 'x')), null);
  assert.equal(documents.imageMediaType(fakeAttachment('noextension', 'x')), null);
});

// ===========================================================================
// openrouter.js — stripImageParts
// ===========================================================================

test('array content is flattened to joined text and reported as changed', () => {
  const { messages, changed } = stripImageParts([{
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '[attached image: shot.png]' },
    ],
  }]);
  assert.equal(changed, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'look at this\n[attached image: shot.png]');
  assert.equal(messages[0].role, 'user', 'the rest of the message survives');
});

test('string-content messages are left alone and report no change', () => {
  const input = [
    { role: 'system', content: 'you are a bot' },
    { role: 'user', content: 'hi' },
  ];
  const { messages, changed } = stripImageParts(input);
  assert.equal(changed, false);
  assert.deepEqual(messages, input);
});

test('a tool-calling assistant turn with null content passes through', () => {
  const input = [{ role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }];
  const { messages, changed } = stripImageParts(input);
  assert.equal(changed, false);
  assert.equal(messages[0].content, null);
  assert.deepEqual(messages[0].tool_calls, [{ id: 'x' }]);
});

test('the input is not mutated — the caller may still need the original', () => {
  const parts = [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ];
  const input = [{ role: 'user', content: parts }];
  const { messages } = stripImageParts(input);
  assert.ok(Array.isArray(input[0].content), 'the original message still holds its parts');
  assert.equal(input[0].content, parts);
  assert.equal(input[0].content.length, 2);
  assert.notEqual(messages[0], input[0], 'a new message object is built');
});

test('an empty or missing message list is handled without throwing', () => {
  assert.deepEqual(stripImageParts([]), { messages: [], changed: false });
  assert.deepEqual(stripImageParts(undefined), { messages: [], changed: false });
});

// -- which model answers a turn with an image ---------------------------------

// The vision pin is a separate axis from the two generation models: it isn't a
// different endpoint, just the ordinary chat call being handed a picture. So it
// falls back to ai_model rather than to an env default, and it only applies to
// turns that actually carry an image.
test('a turn with no image stays on ai_model', withDb(async () => {
  db.setSetting(GUILD, 'ai_model', 'chat/model');
  db.setSetting(GUILD, 'media_vision_model', 'vision/model');
  assert.equal(modelForTurn(GUILD, false), 'chat/model');
}));

test('a turn with an image uses the vision pin when one is set', withDb(async () => {
  db.setSetting(GUILD, 'ai_model', 'chat/model');
  db.setSetting(GUILD, 'media_vision_model', 'vision/model');
  assert.equal(modelForTurn(GUILD, true), 'vision/model');
}));

test('an unset vision pin leaves an image turn on ai_model', withDb(async () => {
  db.setSetting(GUILD, 'ai_model', 'chat/model');
  assert.equal(modelForTurn(GUILD, true), 'chat/model');
}));

// The dashboard sends '' for an empty box, not null — a blank field has to read
// as "no pin" rather than pinning every image turn to the empty string.
test('a blank vision pin saved from the dashboard is treated as unset', withDb(async () => {
  db.setSetting(GUILD, 'ai_model', 'chat/model');
  db.setSetting(GUILD, 'media_vision_model', '');
  assert.equal(modelForTurn(GUILD, true), 'chat/model');
}));

test('media_vision_model defaults to null so the settings PUT accepts it', () => {
  assert.ok('media_vision_model' in db.DEFAULTS);
  assert.equal(db.DEFAULTS.media_vision_model, null);
});
