// Image generation through OpenRouter's images endpoint. Video generation
// used to live here too (OpenRouter's /api/v1/videos, a single paid API
// call) but was replaced by videomaker.js's multi-scene pipeline, which
// calls this module's generateImage() per scene rather than duplicating it.
//
// Authenticated with the same OPENROUTER_API_KEY as the chat client in
// openrouter.js. Spend is logged under the same `[llm]` prefix chat calls
// use, so image cost shows up in the dashboard log next to token cost —
// this bills per generation and costs more per call than a chat completion.
import { OPENROUTER_API_KEY, OPENROUTER_IMAGE_MODEL } from './config.js';

const IMAGES_URL = 'https://openrouter.ai/api/v1/images';

export class MediaError extends Error {}

export const IMAGE_MAX_N = 4;              // images per request

function headers() {
  if (!OPENROUTER_API_KEY) throw new MediaError('OPENROUTER_API_KEY is not set');
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': 'Discord Agent',
  };
}

/** Logs spend to the console (same as chat's [llm] lines) and returns the
 * dollar figure, or 0 when OpenRouter didn't report one — callers that need
 * a real running total (videomaker.js) use the return value; the console
 * line is for the operator watching the dashboard log. */
function logCost(model, kind, usage) {
  const cost = usage?.cost;
  console.log(`[llm] ${model} [${kind}] cost=${cost ?? '?'}`);
  return typeof cost === 'number' ? cost : 0;
}

/** Pull a human-readable message out of an OpenRouter error body. */
export function errorDetail(data, text) {
  const message = data?.error?.message
    || (typeof data?.error === 'string' ? data.error : null)
    || data?.message;
  if (message) return String(message);
  return String(text ?? JSON.stringify(data ?? '')).slice(0, 300);
}

async function readJson(resp) {
  const text = await resp.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

// -- images -------------------------------------------------------------------

/**
 * Generate images.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {string} [opts.aspectRatio] e.g. '1:1', '16:9'
 * @param {number} [opts.n] how many, clamped to IMAGE_MAX_N
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{images: Array<{data: Buffer, mediaType: string}>, costUsd: number}>}
 */
export async function generateImage(prompt, {
  model, aspectRatio, n = 1, signal,
} = {}) {
  if (!String(prompt || '').trim()) throw new MediaError('an image prompt is required');
  const payload = {
    model: model || OPENROUTER_IMAGE_MODEL,
    prompt,
    n: Math.max(1, Math.min(Number(n) || 1, IMAGE_MAX_N)),
    // Asks OpenRouter to report the actual dollar cost on the response —
    // real spend, not a price-table estimate. See openrouter.ai/docs/api-reference/overview#usage-accounting
    usage: { include: true },
  };
  if (aspectRatio) payload.aspect_ratio = aspectRatio;

  const resp = await fetch(IMAGES_URL, {
    method: 'POST', signal, headers: headers(), body: JSON.stringify(payload),
  });
  const { data, text } = await readJson(resp);
  if (!resp.ok) {
    throw new MediaError(`image generation failed (${resp.status}): ${errorDetail(data, text)}`);
  }

  const images = [];
  for (const item of data?.data ?? []) {
    if (!item?.b64_json) continue;
    images.push({
      data: Buffer.from(item.b64_json, 'base64'),
      mediaType: item.media_type || 'image/png',
    });
  }
  if (!images.length) {
    throw new MediaError(`${payload.model} returned no image: ${errorDetail(data, text)}`);
  }
  const costUsd = logCost(payload.model, 'image', data?.usage);
  return { images, costUsd };
}
