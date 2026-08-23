// Native video generation: topic -> script -> per-scene stills -> per-scene
// narration -> FFmpeg assembly -> one mp4. Runs entirely in this process, on
// whatever machine the bot itself runs on (Railway) — no separate app, no
// separate API key, nothing that depends on any other machine being up.
//
// Script and images both go straight to OpenRouter with the same
// OPENROUTER_API_KEY the rest of the bot uses. Narration goes through
// tts.js — the same Fish Audio / Edge TTS path voice replies already use,
// so it's billed (or not) exactly like any other TTS in this bot. FFmpeg is
// already a required runtime dependency for TTS playback (see
// nixpacks.toml), so assembling scenes into a video adds no new system
// dependency, just a different use of a binary that's already there.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from './config.js';
import * as media from './media.js';
import * as tts from './tts.js';

export class VideoMakerError extends Error {}

const SCRIPT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Short and fast on purpose: this runs synchronously inside one Discord
// tool call, not on a scheduler nobody is waiting on. More scenes means
// more sequential OpenRouter/TTS/ffmpeg work before anything gets posted.
const MIN_SCENES = 5;
const MAX_SCENES = 8;
const IMAGE_CONCURRENCY = 3;
const NARRATION_CONCURRENCY = 3;
const RESOLUTION = { width: 1024, height: 576 }; // 16:9

// Stage weights for the overall progress figure reported to onStatus.
const STAGE_WEIGHTS = [['script', 0.05], ['images', 0.45], ['narration', 0.25], ['assemble', 0.25]];

const SYSTEM_PROMPT = `You are a scriptwriter for a narrated video illustrated with still images.

Write a complete script for the given topic, split into ${MIN_SCENES} to ${MAX_SCENES} SCENES.

Each scene is one still illustration on screen while its narration plays. A
scene's narration should be 2-4 sentences (10-25 seconds spoken). Each scene
also needs an image_prompt: a concrete visual description of the single
still illustration for that scene — subject, setting, mood, composition.
Never reference other scenes in an image_prompt; each must stand alone.

Respond with ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "A short, compelling title",
  "description": "1-3 sentences describing the video",
  "tags": ["tag1", "tag2"],
  "scenes": [
    {"narration": "...", "image_prompt": "..."}
  ]
}`;

export function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) throw new VideoMakerError('the script model returned no JSON');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (err) {
    throw new VideoMakerError(`the script model returned malformed JSON: ${err.message}`);
  }
}

/** Real call sites never pass `fetchFn` — same test seam as everywhere else
 * in this codebase (ownerId, now, baseUrl...). */
async function generateScript(topic, notes, model, fetchFn = fetch) {
  if (!OPENROUTER_API_KEY) throw new VideoMakerError('OPENROUTER_API_KEY is not set');
  const userContent = `Topic: ${topic}${notes ? `\nExtra guidance: ${notes}` : ''}`;
  const resp = await fetchFn(SCRIPT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Discord Agent',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
      usage: { include: true },
    }),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
    throw new VideoMakerError(`script generation failed (${resp.status}): ${msg}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new VideoMakerError('script generation returned no content');

  const script = extractJson(content);
  const scenes = script.scenes || [];
  if (!scenes.length) throw new VideoMakerError('the script had zero scenes');
  scenes.forEach((scene, i) => {
    if (!scene.narration || !scene.image_prompt) {
      throw new VideoMakerError(`scene ${i + 1} is missing narration or an image prompt`);
    }
  });
  script.title = script.title || topic;
  script.description = script.description || '';
  script.tags = script.tags || [];
  return { script, costUsd: data?.usage?.cost || 0 };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order
 * in the result array regardless of completion order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (let i = next; i < items.length; i = next) {
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function generateImages(scenes, imageModel, onProgress, generateImageFn = media.generateImage) {
  let done = 0;
  let costUsd = 0;
  const images = await mapWithConcurrency(scenes, IMAGE_CONCURRENCY, async (scene) => {
    const result = await generateImageFn(scene.image_prompt, { model: imageModel, aspectRatio: '16:9' });
    costUsd += result.costUsd || 0;
    done += 1;
    onProgress?.(done / scenes.length);
    return result.images[0];
  });
  return { images, costUsd };
}

async function generateNarration(scenes, guildId, onProgress, synthesizeFn = tts.synthesize) {
  let done = 0;
  return mapWithConcurrency(scenes, NARRATION_CONCURRENCY, async (scene) => {
    const audio = await synthesizeFn(scene.narration, { guildId });
    if (!audio) throw new VideoMakerError('narration failed for a scene — no TTS backend produced audio');
    done += 1;
    onProgress?.(done / scenes.length);
    return audio;
  });
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
export function extensionFor(mediaType) {
  const type = String(mediaType || 'image/png').split(';')[0].trim().toLowerCase();
  return EXTENSIONS[type] || type.split('/')[1] || 'png';
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new VideoMakerError(`ffmpeg failed: ${String(stderr || err.message).slice(-1500)}`));
        return;
      }
      resolve();
    });
  });
}

async function assembleVideo(images, audios, workDir, onProgress, runFfmpegFn = runFfmpeg) {
  const segDir = path.join(workDir, 'segments');
  await mkdir(segDir, { recursive: true });
  const { width, height } = RESOLUTION;
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

  const segments = [];
  for (let i = 0; i < images.length; i += 1) {
    const imgPath = path.join(workDir, `scene_${i + 1}.${extensionFor(images[i].mediaType)}`);
    const audPath = path.join(workDir, `scene_${i + 1}.mp3`);
    // eslint-disable-next-line no-await-in-loop
    await writeFile(imgPath, images[i].data);
    // eslint-disable-next-line no-await-in-loop
    await writeFile(audPath, audios[i]);
    const segPath = path.join(segDir, `seg_${i + 1}.mp4`);
    // eslint-disable-next-line no-await-in-loop
    await runFfmpegFn([
      '-y', '-loop', '1', '-i', imgPath, '-i', audPath,
      '-vf', scale, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'medium',
      '-r', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-shortest', segPath,
    ]);
    segments.push(segPath);
    onProgress?.((i + 1) / images.length);
  }

  const concatList = path.join(workDir, 'concat.txt');
  await writeFile(
    concatList,
    segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  const finalPath = path.join(workDir, 'final.mp4');
  await runFfmpegFn(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', finalPath]);
  return finalPath;
}

/**
 * Generate a full narrated video from a topic.
 *
 * @param {string} topic
 * @param {object} [opts]
 * @param {string} [opts.guildId] which server this is for — passed through
 *   to tts.synthesize so narration is billed/voiced per that guild's config
 * @param {string} [opts.notes] extra guidance for the script
 * @param {string} [opts.imageModel] per-guild image model override
 * @param {string} [opts.scriptModel] per-guild script model override
 * @param {(info: {stage: string, stageProgress: number, progress: number,
 *   costUsd: number}) => Promise<void>} [opts.onStatus] awaited on every
 *   stage transition and scene completion
 * @param {object} [opts.deps] test-only overrides — real call sites never
 *   pass this. { fetchFn, generateImageFn, synthesizeFn, runFfmpegFn }
 * @returns {Promise<{data: Buffer, contentType: string, title: string,
 *   description: string, sceneCount: number, costUsd: number}>}
 */
export async function createVideo(topic, {
  guildId, notes, imageModel, scriptModel, onStatus, deps = {},
} = {}) {
  if (!String(topic || '').trim()) throw new VideoMakerError('a video topic is required');
  if (!OPENROUTER_API_KEY) throw new VideoMakerError('OPENROUTER_API_KEY is not set');

  const weightBefore = (stage) => {
    let sum = 0;
    for (const [name, weight] of STAGE_WEIGHTS) {
      if (name === stage) return sum;
      sum += weight;
    }
    return sum;
  };
  const weightOf = (stage) => STAGE_WEIGHTS.find(([name]) => name === stage)[1];
  const report = async (stage, stageProgress, costUsd) => {
    if (!onStatus) return;
    await onStatus({
      stage, stageProgress, costUsd,
      progress: weightBefore(stage) + weightOf(stage) * stageProgress,
    });
  };

  const workDir = await mkdtemp(path.join(tmpdir(), 'video-'));
  let totalCost = 0;
  try {
    await report('script', 0, totalCost);
    const { script, costUsd: scriptCost } = await generateScript(
      topic, notes, scriptModel || OPENROUTER_MODEL, deps.fetchFn,
    );
    totalCost += scriptCost;
    const { scenes } = script;
    await report('script', 1, totalCost);

    const { images, costUsd: imagesCost } = await generateImages(
      scenes, imageModel, (p) => report('images', p, totalCost), deps.generateImageFn,
    );
    totalCost += imagesCost;

    const audios = await generateNarration(
      scenes, guildId, (p) => report('narration', p, totalCost), deps.synthesizeFn,
    );

    const finalPath = await assembleVideo(
      images, audios, workDir, (p) => report('assemble', p, totalCost), deps.runFfmpegFn,
    );

    const data = await readFile(finalPath);
    return {
      data,
      contentType: 'video/mp4',
      title: script.title,
      description: script.description,
      sceneCount: scenes.length,
      costUsd: totalCost,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
