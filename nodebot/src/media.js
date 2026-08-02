// Image and video generation through OpenRouter's media endpoints.
//
// Two different APIs, both authenticated with the same OPENROUTER_API_KEY as
// the chat client in openrouter.js:
//
//   images   POST /api/v1/images        synchronous — the finished image comes
//                                       back base64-encoded in the response body
//   videos   POST /api/v1/videos        asynchronous — returns 202 and a polling
//            GET  /api/v1/videos/{id}   url, because generation runs for minutes;
//                                       we poll to completion and download
//
// Spend is logged under the same `[llm]` prefix chat calls use, so image and
// video cost shows up in the dashboard log next to token cost — these bill
// per generation and cost far more per call than a chat completion.
import { OPENROUTER_API_KEY, OPENROUTER_IMAGE_MODEL, OPENROUTER_VIDEO_MODEL } from './config.js';

const IMAGES_URL = 'https://openrouter.ai/api/v1/images';
const VIDEOS_URL = 'https://openrouter.ai/api/v1/videos';

export class MediaError extends Error {}

export const IMAGE_MAX_N = 4;              // images per request
export const VIDEO_POLL_INTERVAL_MS = 5_000;
export const VIDEO_POLL_TIMEOUT_MS = 600_000; // stop waiting after 10 minutes

// Job states meaning "not done yet" — anything else ends the poll loop.
const PENDING_STATES = new Set(['pending', 'queued', 'in_progress', 'processing', 'running']);

function headers() {
  if (!OPENROUTER_API_KEY) throw new MediaError('OPENROUTER_API_KEY is not set');
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': 'Discord Agent',
  };
}

function logCost(model, kind, usage) {
  console.log(`[llm] ${model} [${kind}] cost=${usage?.cost ?? '?'}`);
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

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
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
 * @returns {Promise<Array<{data: Buffer, mediaType: string}>>}
 */
export async function generateImage(prompt, {
  model, aspectRatio, n = 1, signal,
} = {}) {
  if (!String(prompt || '').trim()) throw new MediaError('an image prompt is required');
  const payload = {
    model: model || OPENROUTER_IMAGE_MODEL,
    prompt,
    n: Math.max(1, Math.min(Number(n) || 1, IMAGE_MAX_N)),
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
  logCost(payload.model, 'image', data?.usage);
  return images;
}

// -- video --------------------------------------------------------------------

/**
 * Generate a video: submit the job, poll until it finishes, download the clip.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.duration] seconds
 * @param {string} [opts.resolution] e.g. '720p'
 * @param {string} [opts.aspectRatio] e.g. '16:9'
 * @param {AbortSignal} [opts.signal]
 * @param {(status: string) => Promise<void>} [opts.onStatus] awaited whenever
 *   the job's status changes, so a caller can keep somebody posted during the
 *   minutes this takes
 * @param {() => number} [opts.now] injectable clock, for tests
 * @returns {Promise<{data: Buffer, contentType: string}>}
 */
export async function generateVideo(prompt, {
  model, duration, resolution, aspectRatio, signal, onStatus, now = Date.now,
} = {}) {
  if (!String(prompt || '').trim()) throw new MediaError('a video prompt is required');
  const payload = { model: model || OPENROUTER_VIDEO_MODEL, prompt };
  if (duration) payload.duration = Number(duration);
  if (resolution) payload.resolution = resolution;
  if (aspectRatio) payload.aspect_ratio = aspectRatio;

  const submit = await fetch(VIDEOS_URL, {
    method: 'POST', signal, headers: headers(), body: JSON.stringify(payload),
  });
  const submitted = await readJson(submit);
  if (!submit.ok) {
    throw new MediaError(
      `video generation failed (${submit.status}): ${errorDetail(submitted.data, submitted.text)}`,
    );
  }

  let job = submitted.data;
  const pollUrl = job?.polling_url || (job?.id ? `${VIDEOS_URL}/${job.id}` : null);
  if (!pollUrl) {
    throw new MediaError(`the video job response had no id: ${errorDetail(job, submitted.text)}`);
  }

  const deadline = now() + VIDEO_POLL_TIMEOUT_MS;
  let status = job?.status || 'pending';
  let lastStatus = null;
  while (PENDING_STATES.has(status)) {
    if (now() > deadline) {
      throw new MediaError(
        `the video was still ${status} after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 60_000)} minutes`
        + ` — it may still finish, but I stopped waiting (job ${job?.id ?? '?'})`,
      );
    }
    if (onStatus && status !== lastStatus) {
      lastStatus = status;
      // eslint-disable-next-line no-await-in-loop
      await onStatus(status);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(VIDEO_POLL_INTERVAL_MS, signal);
    // eslint-disable-next-line no-await-in-loop
    const poll = await fetch(pollUrl, { signal, headers: headers() });
    // eslint-disable-next-line no-await-in-loop
    const polled = await readJson(poll);
    if (!poll.ok) {
      throw new MediaError(
        `polling the video job failed (${poll.status}): ${errorDetail(polled.data, polled.text)}`,
      );
    }
    job = polled.data;
    status = job?.status || 'pending';
  }

  if (status !== 'completed') {
    throw new MediaError(`video generation ${status}: ${errorDetail(job, '')}`);
  }
  const url = job?.unsigned_urls?.[0];
  if (!url) throw new MediaError('the video job finished but returned no download url');

  logCost(payload.model, 'video', job?.usage);
  const clip = await fetch(url, { signal, headers: headers() });
  if (!clip.ok) {
    throw new MediaError(`downloading the finished video failed (${clip.status})`);
  }
  return {
    data: Buffer.from(await clip.arrayBuffer()),
    contentType: (clip.headers?.get?.('content-type') || 'video/mp4').split(';')[0].trim(),
  };
}
