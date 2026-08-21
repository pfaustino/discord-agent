// Music generation through OpenRouter, backed by Google's Lyria 3 models.
// Unlike images (media.js's /api/v1/images) there is no dedicated music
// endpoint on OpenRouter — audio output rides the same /chat/completions
// endpoint ordinary replies use, requesting modalities: ['text', 'audio'].
// OpenRouter documents audio output as stream-only, so this reads the
// response as SSE and concatenates the base64 audio deltas into one clip,
// billed to the same OPENROUTER_API_KEY as everything else.
import { OPENROUTER_API_KEY } from './config.js';

export class MusicError extends Error {}

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Lyria 3 Clip: ~30s, $0.04/clip — fast, cheap, good for trying an idea.
// Lyria 3 Pro: a full structured song (intro/verse/chorus/bridge) up to a
// few minutes, $0.08/song — reach for it once the direction is settled.
export const MUSIC_MODELS = { short: 'google/lyria-3-clip-preview', full: 'google/lyria-3-pro-preview' };

function headers() {
  if (!OPENROUTER_API_KEY) throw new MusicError('OPENROUTER_API_KEY is not set');
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': 'Discord Agent',
  };
}

/** Parse an SSE body ("data: {...}\n\n" framing, terminated by "data: [DONE]")
 * into parsed JSON events. Reads via getReader() rather than async-iterating
 * the stream directly, since that's the one interface every ReadableStream
 * implementation is guaranteed to have. */
async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          if (!data) continue;
          try {
            yield JSON.parse(data);
          } catch {
            // partial/malformed line — ignore rather than aborting the clip
          }
        }
        idx = buf.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Generate one music clip from a text prompt.
 *
 * Genre, mood, instruments, tempo, structure and lyrics all ride in the
 * prompt text itself — Lyria takes no separate parameters for them.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {'short'|'full'} [opts.length] 'short' (default) = a ~30s clip on
 *   Lyria 3 Clip; 'full' = a complete song on Lyria 3 Pro.
 * @param {typeof fetch} [opts.fetchFn] test-only override — real call sites
 *   never pass this.
 * @returns {Promise<{data: Buffer, mediaType: string, transcript: string, costUsd: number}>}
 */
export async function generateMusic(prompt, { length = 'short', fetchFn = fetch } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new MusicError('a music prompt is required');
  const model = MUSIC_MODELS[length] || MUSIC_MODELS.short;

  const resp = await fetchFn(CHAT_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: text }],
      modalities: ['text', 'audio'],
      audio: { format: 'mp3' },
      stream: true,
      usage: { include: true },
    }),
  });

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const raw = await resp.text();
      const data = JSON.parse(raw);
      detail = data?.error?.message || raw.slice(0, 300) || detail;
    } catch {
      // non-JSON error body — the HTTP status is all we get
    }
    throw new MusicError(`music generation failed (${resp.status}): ${detail}`);
  }
  if (!resp.body) throw new MusicError('music generation returned no stream');

  let audioB64 = '';
  let transcript = '';
  let costUsd = 0;
  for await (const event of sseEvents(resp.body)) {
    if (event?.error) throw new MusicError(event.error.message || 'music generation failed mid-stream');
    const delta = event?.choices?.[0]?.delta;
    if (delta?.audio?.data) audioB64 += delta.audio.data;
    if (delta?.audio?.transcript) transcript += delta.audio.transcript;
    if (typeof event?.usage?.cost === 'number') costUsd = event.usage.cost;
  }
  if (!audioB64) throw new MusicError(`${model} returned no audio`);

  console.log(`[llm] ${model} [music] cost=${costUsd || '?'}`);
  return {
    data: Buffer.from(audioB64, 'base64'), mediaType: 'audio/mpeg', transcript: transcript.trim(), costUsd,
  };
}
