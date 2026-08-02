// TTS synthesis — port of tts.py. Fish Audio when FISH_API_KEY is set, with
// msedge-tts (free, unofficial Edge Read Aloud API) as the fallback.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { FISH_API_KEY, FISH_TTS_MODEL } from './config.js';
import * as credits from './credits/index.js';
import { ttsConfigForGuild } from './ttsConfig.js';

const FISH_URL = 'https://api.fish.audio/v1/tts';

// S1's fixed tag vocabulary (emotions, tones, effects) — same list the
// model is prompted with; used here only to strip tags for text display.
const S1_TAGS = [
  'angry', 'sad', 'disdainful', 'excited', 'surprised', 'satisfied',
  'unhappy', 'anxious', 'hysterical', 'delighted', 'scared', 'worried',
  'indifferent', 'upset', 'impatient', 'nervous', 'guilty', 'scornful',
  'frustrated', 'depressed', 'panicked', 'furious', 'empathetic',
  'embarrassed', 'reluctant', 'disgusted', 'keen', 'moved', 'proud',
  'relaxed', 'grateful', 'confident', 'interested', 'curious', 'confused',
  'joyful', 'disapproving', 'negative', 'denying', 'astonished', 'serious',
  'sarcastic', 'conciliative', 'comforting', 'sincere', 'sneering',
  'hesitating', 'yielding', 'painful', 'awkward', 'amused',
  'in a hurry tone', 'shouting', 'screaming', 'whispering', 'soft tone',
  'laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing',
  'panting', 'groaning', 'break', 'long-break', 'breath',
  'laugh', 'cough', 'sigh', 'lip-smacking',
];
const TAG_RE = new RegExp(
  `\\((?:${[...S1_TAGS].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\)\\s*`,
  'ig',
);
// S2 models take free-form [bracketed] voice directions anywhere in the text.
const S2_TAG_RE = /\[[^[\]\n]{1,60}\]\s*/g;

export function fishEnabled() {
  return Boolean(FISH_API_KEY);
}

export function isS2(guildId = null) {
  const model = guildId != null ? ttsConfigForGuild(guildId).fishModel : FISH_TTS_MODEL;
  return model.toLowerCase().startsWith('s2');
}

export function stripVoiceTags(text) {
  return text.replace(TAG_RE, '').replace(S2_TAG_RE, '').trim();
}

// Per-request text budget for each backend. A longer reply is split at
// sentence boundaries and synthesized piece by piece, then the MP3s are
// concatenated — MP3 is a stream of self-contained frames, so joining the
// bytes plays back as one continuous clip. That keeps the single-blob
// contract speakInVoice() expects while letting a multi-paragraph reply be
// spoken in full; both backends used to hard-slice and drop the remainder.
const FISH_CHUNK = 1500;
const EDGE_CHUNK = 700;
// Ceiling on synthesis calls per reply, so a runaway answer can't fan out
// into dozens of API requests. Hitting it is logged, never silent.
const MAX_CHUNKS = 8;

/** Split text into <=limit pieces, preferring sentence/paragraph breaks. */
export function splitForTts(text, limit) {
  const pieces = String(text).split(/(?<=[.!?])\s+|\n+/).filter((p) => p.trim());
  const chunks = [];
  let cur = '';
  for (let piece of pieces) {
    // A single sentence longer than the budget still has to be broken up.
    while (piece.length > limit) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(piece.slice(0, limit));
      piece = piece.slice(limit);
    }
    if (!cur) cur = piece;
    else if (cur.length + 1 + piece.length <= limit) cur += ` ${piece}`;
    else { chunks.push(cur); cur = piece; }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function synthesizeWith(text, limit, backend, label) {
  let chunks = splitForTts(text, limit);
  if (!chunks.length) return null;
  if (chunks.length > MAX_CHUNKS) {
    console.warn(`[tts] reply needs ${chunks.length} ${label} chunks — speaking the first ${MAX_CHUNKS}`);
    chunks = chunks.slice(0, MAX_CHUNKS);
  }
  const parts = [];
  for (const chunk of chunks) {
    const audio = await backend(chunk);
    if (!audio) return null; // fall through to the next backend for the whole reply
    parts.push(audio);
  }
  return Buffer.concat(parts);
}

/* ── Measuring what was synthesized ─────────────────────────────────────────

   Fish Audio bills per minute, so metering needs a duration. It is read out
   of the MP3 that came back rather than guessed from the text length: an
   estimate made before the call is exactly what the metering rules rule out,
   and characters-per-second is wrong by a wide margin on a reply full of
   voice tags, numbers or abbreviations.

   MP3 is a stream of self-contained frames, each carrying its own bitrate in
   its header. Fish returns constant bitrate, so reading the first frame
   header and dividing the total byte count by it is exact. */

const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_L3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000],  // MPEG 2.5
};

/**
 * Seconds of audio in a constant-bitrate MP3 buffer, or 0 if it can't be read.
 *
 * Returning 0 rather than a guess is deliberate: a duration we could not
 * measure bills nothing, so a format change upstream shows up as revenue
 * going missing in the usage report rather than as customers being charged
 * against a number we invented.
 */
export function mp3DurationSec(buf) {
  if (!buf || buf.length < 4) return 0;
  // Skip an ID3v2 tag if there is one — its header carries a syncsafe length.
  let i = 0;
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14
      | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  for (; i + 3 < buf.length; i += 1) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buf[i + 1] >> 3) & 0x03;
    const layerBits = (buf[i + 1] >> 1) & 0x03;
    if (versionBits === 1 || layerBits !== 1) continue; // reserved, or not Layer III
    const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
    const sampleIndex = (buf[i + 2] >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) continue;
    const table = versionBits === 3 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES;
    const kbps = table[bitrateIndex];
    if (!kbps) continue;
    return ((buf.length - i) * 8) / (kbps * 1000);
  }
  return 0;
}

/**
 * Returns audio bytes (Buffer) for text, or null if no TTS backend works.
 *
 * Only the Fish path bills. edge-tts is free to us and free to the customer,
 * which also means a managed bot that has run out of Fish quota degrades to a
 * lesser voice rather than to silence.
 *
 * There is no credit gate here. By the time a reply is being spoken the
 * expensive part — generating it — has already been gated and paid for, and
 * refusing to speak a reply that already exists would strand the bot
 * mid-conversation for the sake of a few credits.
 */
export async function synthesize(text, { guildId = null } = {}) {
  const cfg = ttsConfigForGuild(guildId);
  if (fishEnabled()) {
    const audio = await synthesizeWith(text, FISH_CHUNK, (chunk) => fish(chunk, cfg), 'Fish');
    if (audio) {
      const seconds = mp3DurationSec(audio);
      if (seconds > 0) {
        credits.meter(credits.contextFor(guildId), {
          kind: 'tts-fish',
          quantity: seconds / 60,
          meta: { model: cfg.fishModel, seconds: Math.round(seconds * 10) / 10 },
        });
      } else {
        console.warn('[tts] could not read a duration from the Fish audio — not billing it');
      }
      return audio;
    }
  }
  return synthesizeWith(stripVoiceTags(text), EDGE_CHUNK, (chunk) => edge(chunk, cfg), 'edge');
}

async function fish(text, cfg) {
  const payload = { text, format: 'mp3', latency: 'normal' };
  if (cfg.fishVoiceId) payload.reference_id = cfg.fishVoiceId;
  let resp;
  try {
    resp = await fetch(FISH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        model: cfg.fishModel,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[tts] Fish Audio request failed:', err.message);
    return null;
  }
  if (!resp.ok) {
    console.warn(`[tts] Fish Audio ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return null;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.length ? buf : null;
}

async function edge(text, cfg) {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(cfg.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    return buf.length ? buf : null;
  } catch (err) {
    console.log('[tts] edge-tts unavailable:', err.message);
    return null;
  }
}
