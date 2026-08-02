// Image and video generation. media.js's HTTP goes through the global fetch,
// which is swapped for a fake here (same seam openrouter.test.js uses) — the
// sandbox's egress allowlist blocks OpenRouter anyway, and these are about
// control flow: how a b64 payload becomes a Buffer, how the video job is
// polled, and who is allowed to spend money on either.
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

const OWNER = 'owner-1';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function binaryResponse(buf, contentType = 'video/mp4') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => Uint8Array.from(buf).buffer,
  };
}

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = original; });
}

/** generateVideo sleeps VIDEO_POLL_INTERVAL_MS (5s) between polls using the
 * global setTimeout, so a two-poll test would otherwise take ten seconds.
 * The interval is a module const and can't be injected, but sleep() resolves
 * setTimeout off globalThis at call time — so swap it, same shape as
 * withFetch. Only the delay is faked; ordering is untouched. */
function withInstantSleep(run) {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => original(fn, 0, ...args);
  return run().finally(() => { globalThis.setTimeout = original; });
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
    const images = await media.generateImage('a cat');
    assert.equal(images.length, 1);
    assert.ok(Buffer.isBuffer(images[0].data));
    assert.equal(images[0].data.toString(), 'PNGBYTES');
    assert.equal(images[0].mediaType, 'image/webp');
  },
));

test('media type falls back to image/png when the API omits it', () => withFetch(
  async () => jsonResponse({ data: [{ b64_json: b64('x') }] }),
  async () => {
    assert.equal((await media.generateImage('a cat'))[0].mediaType, 'image/png');
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
// media.js — generateVideo
// ===========================================================================

/** Submit -> poll -> download, with a scripted list of job states. Each entry
 * is either a bare status string or a whole job body; the first is what the
 * submit returns, the rest are handed out one per poll (the last repeats). */
function videoFetch(states, { clip = 'MP4BYTES', contentType = 'video/mp4' } = {}) {
  const calls = [];
  const job = (i) => {
    const state = states[Math.min(i, states.length - 1)];
    return { id: 'job-1', ...(typeof state === 'string' ? { status: state } : state) };
  };
  let polls = 0;
  const fn = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url === 'https://openrouter.ai/api/v1/videos') return jsonResponse(job(0));
    if (url.startsWith('https://openrouter.ai/api/v1/videos/')) {
      polls += 1;
      return jsonResponse(job(polls));
    }
    return binaryResponse(Buffer.from(clip), contentType);
  };
  return { fn, calls };
}

test('submits, polls through in_progress, then downloads unsigned_urls[0]', () => {
  const statuses = [];
  const { fn, calls } = videoFetch([
    'queued',
    { status: 'in_progress' },
    { status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] },
  ]);
  return withInstantSleep(() => withFetch(fn, async () => {
    const clip = await media.generateVideo('a dog running', {
      duration: 6, resolution: '720p', aspectRatio: '16:9', onStatus: async (s) => statuses.push(s),
    });
    assert.ok(Buffer.isBuffer(clip.data));
    assert.equal(clip.data.toString(), 'MP4BYTES');
    assert.equal(clip.contentType, 'video/mp4');

    // submit, poll, poll, download
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/videos');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/videos/job-1');
    assert.equal(calls[3].url, 'https://files.example/clip.mp4');
    // each distinct state is announced once, in order
    assert.deepEqual(statuses, ['queued', 'in_progress']);
  }));
});

test('duration, resolution and aspect ratio are passed through to the job', () => {
  const { fn, calls } = videoFetch([
    { status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] },
  ]);
  return withFetch(fn, async () => {
    await media.generateVideo('a dog', { duration: 8, resolution: '480p', aspectRatio: '9:16' });
    assert.equal(calls[0].body.duration, 8);
    assert.equal(calls[0].body.resolution, '480p');
    assert.equal(calls[0].body.aspect_ratio, '9:16');
    assert.equal(calls[0].body.prompt, 'a dog');
  });
});

test('a content type with parameters is trimmed down to the bare type', () => {
  const { fn } = videoFetch(
    [{ status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] }],
    { contentType: 'video/mp4; codecs="avc1"' },
  );
  return withFetch(fn, async () => {
    assert.equal((await media.generateVideo('a dog')).contentType, 'video/mp4');
  });
});

test('a failed job throws with the upstream reason attached', () => {
  const { fn } = videoFetch([
    'queued',
    { status: 'failed', error: { message: 'the prompt was rejected by the safety filter' } },
  ]);
  return withInstantSleep(() => withFetch(fn, async () => {
    await assert.rejects(
      media.generateVideo('a dog'),
      (err) => err instanceof media.MediaError
        && /failed/.test(err.message)
        && /safety filter/.test(err.message),
    );
  }));
});

test('completing with no download url throws instead of returning nothing', () => {
  const { fn } = videoFetch([{ status: 'completed', unsigned_urls: [] }]);
  return withFetch(fn, async () => {
    await assert.rejects(media.generateVideo('a dog'), /no download url/);
  });
});

test('a job response with no id at all is rejected up front', () => withFetch(
  async () => jsonResponse({ status: 'queued' }),
  async () => {
    await assert.rejects(media.generateVideo('a dog'), /no id/);
  },
));

test('a job that never finishes times out rather than polling forever', () => {
  // The injected clock is the whole point of the `now` option: first call
  // sets the deadline, then it jumps past it so the loop gives up on its
  // second pass — after one real poll, without waiting ten minutes.
  const ticks = [0, 0, media.VIDEO_POLL_TIMEOUT_MS + 1];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)];
  const { fn, calls } = videoFetch(['queued', { status: 'in_progress' }]);
  return withInstantSleep(() => withFetch(fn, async () => {
    await assert.rejects(
      media.generateVideo('a dog', { now }),
      (err) => err instanceof media.MediaError
        && /still in_progress/.test(err.message)
        && /stopped waiting/.test(err.message),
    );
    assert.equal(calls.length, 2, 'gave up after one poll, and never downloaded');
  }));
});

test('a blank video prompt is rejected before any request goes out', () => {
  let calls = 0;
  return withFetch(
    async () => { calls += 1; return jsonResponse({}); },
    async () => {
      await assert.rejects(media.generateVideo('  '), media.MediaError);
      assert.equal(calls, 0);
    },
  );
});

// ===========================================================================
// mediaTools.js
// ===========================================================================

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
        const notice = { id: `msg-${sent.length}`, delete: async () => { deleted.push(notice.id); } };
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

test('the video hourly cap refuses past the limit without calling the API', withDb(async () => {
  db.setSetting('1', 'media_video_hourly_cap', 1);
  const { fn, calls } = videoFetch([
    { status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] },
  ]);
  await withFetch(fn, async () => {
    const message = fakeMessage();

    const first = await mediaTools.execute(
      null, message, 'generate_video', { prompt: 'a dog running' }, OWNER,
    );
    assert.match(first, /ALREADY POSTED/);
    const afterFirst = calls.length;
    assert.ok(afterFirst > 0, 'the first video should have reached the API');

    const second = await mediaTools.execute(
      null, message, 'generate_video', { prompt: 'a dog running again' }, OWNER,
    );
    assert.match(second, /^Error: /);
    assert.match(second, /cap/);
    assert.equal(calls.length, afterFirst, 'the refused attempt must not reach the API');
  });
}));

test('a cap of 0 means unlimited', withDb(async () => {
  db.setSetting('1', 'media_video_hourly_cap', 0);
  const { fn } = videoFetch([
    { status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] },
  ]);
  await withFetch(fn, async () => {
    const message = fakeMessage();
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await mediaTools.execute(
        null, message, 'generate_video', { prompt: 'a dog' }, OWNER,
      );
      assert.match(result, /ALREADY POSTED/);
    }
  });
}));

test('the "hang tight" notice is cleaned up after the clip is posted', withDb(async () => {
  const { fn } = videoFetch([
    { status: 'completed', unsigned_urls: ['https://files.example/clip.mp4'] },
  ]);
  await withFetch(fn, async () => {
    const message = fakeMessage();
    await mediaTools.execute(null, message, 'generate_video', { prompt: 'a dog' }, OWNER);
    assert.equal(message._sent.length, 2, 'the notice, then the clip');
    assert.match(String(message._sent[0]), /hang tight/);
    assert.deepEqual(message._deleted, ['msg-1'], 'the notice should be deleted');
    assert.equal(message._sent[1].files[0].name, 'generated_video.mp4');
  });
}));

test('the notice is cleaned up even when generation fails', withDb(async () => {
  await withFetch(
    async () => jsonResponse({ error: { message: 'upstream exploded' } }, 500),
    async () => {
      const message = fakeMessage();
      const result = await mediaTools.execute(
        null, message, 'generate_video', { prompt: 'a dog' }, OWNER,
      );
      assert.match(result, /^Error: /);
      assert.deepEqual(message._deleted, ['msg-1'], 'a stale notice must not be left behind');
    },
  );
}));

test('every registered tool has a schema of the same name', () => {
  assert.deepEqual(
    mediaTools.TOOL_SCHEMAS.map((s) => s.function.name).sort(),
    Object.keys(mediaTools.TOOLS).sort(),
  );
  assert.ok(mediaTools.TOOL_SCHEMAS.every((s) => s.function.parameters.required.includes('prompt')));
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
