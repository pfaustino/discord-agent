// TTS synthesis — port of tts.py. Fish Audio when FISH_API_KEY is set, with
// msedge-tts (free, unofficial Edge Read Aloud API) as the fallback.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { FISH_API_KEY, FISH_TTS_MODEL, FISH_VOICE_ID } from './config.js';

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

export function isS2() {
  return FISH_TTS_MODEL.toLowerCase().startsWith('s2');
}

export function stripVoiceTags(text) {
  return text.replace(TAG_RE, '').replace(S2_TAG_RE, '').trim();
}

/** Returns audio bytes (Buffer) for text, or null if no TTS backend works. */
export async function synthesize(text) {
  if (fishEnabled()) {
    const audio = await fish(text);
    if (audio) return audio;
  }
  return edge(stripVoiceTags(text));
}

async function fish(text) {
  const payload = { text: text.slice(0, 2000), format: 'mp3', latency: 'normal' };
  if (FISH_VOICE_ID) payload.reference_id = FISH_VOICE_ID;
  let resp;
  try {
    resp = await fetch(FISH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        model: FISH_TTS_MODEL,
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

async function edge(text) {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('en-US-GuyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text.slice(0, 800));
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    return buf.length ? buf : null;
  } catch (err) {
    console.log('[tts] edge-tts unavailable:', err.message);
    return null;
  }
}
