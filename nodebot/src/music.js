// Music generation through OpenRouter, backed by Google's Lyria 3 models.
// Unlike images (media.js's /api/v1/images) there is no dedicated music
// endpoint on OpenRouter — audio output rides the same /chat/completions
// endpoint ordinary replies use, requesting modalities: ['text', 'audio'].
//
// The request/response shape here is verified against a working reference
// implementation (a separate local Next.js app on this machine that already
// generates real Lyria 3 clips through OpenRouter), not just OpenRouter's
// own thin docs for this feature — in particular: audio-output requests are
// rejected unless stream: true, and each streamed delta.audio.data chunk is
// its own independently-decodable base64 fragment — decode every chunk on
// its own and concatenate the resulting byte Buffers, NOT the base64
// strings first. Getting that backwards produces corrupted audio the moment
// two chunks land on a base64 padding boundary.
import { OPENROUTER_API_KEY, PUBLIC_URL } from './config.js';

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
    // Sent alongside X-Title on the reference implementation's audio-output
    // calls; harmless elsewhere, but audio-output is new enough on
    // OpenRouter that it isn't worth dropping a header a working
    // integration actually sends.
    'HTTP-Referer': PUBLIC_URL || 'https://github.com/seed0001/discord-agent',
    'X-Title': 'Discord Agent',
  };
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
 * @returns {Promise<{data: Buffer, mediaType: string, costUsd: number}>}
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
      // OpenRouter rejects audio-output requests outright without this
      // ("Audio output requires stream: true") — confirmed against the
      // reference implementation, not assumed from general docs.
      stream: true,
      usage: { include: true },
    }),
  });

  if (!resp.ok || !resp.body) {
    const raw = await resp.text().catch(() => '');
    let detail = `HTTP ${resp.status}`;
    try {
      detail = JSON.parse(raw)?.error?.message || raw.slice(0, 300) || detail;
    } catch {
      if (raw) detail = raw.slice(0, 300);
    }
    throw new MusicError(`music generation failed (${resp.status}): ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let audioFormat;
  let costUsd = 0;
  let buffer = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]' || !data) continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue; // partial/malformed line — ignore rather than aborting the clip
        }
        if (event.error) throw new MusicError(event.error.message || 'music generation failed mid-stream');

        const audio = event.choices?.[0]?.delta?.audio;
        if (audio?.data) chunks.push(Buffer.from(audio.data, 'base64'));
        if (audio?.format) audioFormat = audio.format;
        if (typeof event.usage?.cost === 'number') costUsd = event.usage.cost;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!chunks.length) throw new MusicError(`${model} returned no audio`);

  console.log(`[llm] ${model} [music] cost=${costUsd || '?'}`);
  return { data: Buffer.concat(chunks), mediaType: `audio/${audioFormat === 'mp3' ? 'mpeg' : (audioFormat || 'mpeg')}`, costUsd };
}
