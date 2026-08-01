// Smart mention detection — the replacement for exact wake-word matching.
//
// The problem with wake words is that they are matched against a TRANSCRIPT,
// and transcription is lossy in exactly the place it hurts most: names.
// "Hey Amy" comes back as "hey aim ee", "hey am I", "hey Emmy". A substring
// match sees none of those, so the bot sits there while someone is plainly
// talking to it. Loosening the match instead makes it fire on "hey man".
//
// So detection is split in two, and this module is the FIRST half:
//
//   stage 1 (here)   — cheap: was the bot referred to by name at all?
//                      High recall on purpose. Being talked about counts.
//   stage 2 (voice)  — the main conversational model gets the transcript and
//                      the fact that the name came up, and decides whether it
//                      is being SPOKEN TO or merely SPOKEN ABOUT.
//
// The split is what makes it work. A single pass that has to be both
// forgiving about mishearings AND strict about intent has to trade one for
// the other; two passes each get one job. Stage 1 can say "yes, someone said
// something like your name" without committing to a reply, and stage 2 can
// reason over the whole conversation — "so what did Amy say?" is a mention
// and not an address, and only something reading the conversation can tell.
import { chat, OpenRouterError } from './openrouter.js';
import { normalizePhrase } from './phrases.js';
import { botName } from './botName.js';
import * as db from './db.js';

/** Utterances shorter than this are not worth a model call. */
const MIN_WORDS_FOR_CLASSIFIER = 2;
/** Nor are very long ones — a monologue is not someone calling out a name. */
const MAX_CHARS_FOR_CLASSIFIER = 600;
/** Per-channel floor between classifier calls, so a busy room cannot drain
 *  the background budget that memory upkeep and de-escalation also draw on. */
export const CLASSIFY_COOLDOWN_MS = 2_000;

const lastClassify = new Map();  // channelId -> ms timestamp

/** Levenshtein distance, capped — we only ever care about "0, 1, or more". */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * The local fast path: does the name appear more or less verbatim?
 *
 * Deliberately HIGH PRECISION and low recall — it exists to skip the model
 * call in the common case ("hey amy" really does contain "amy"), not to be
 * the detector. Everything it misses falls through to the classifier, which
 * is the part that actually handles mishearings. Being loose here would put
 * false positives on the zero-latency path where nothing can catch them.
 */
export function looksLikeMention(text, name) {
  const needle = normalizePhrase(name);
  if (!needle) return false;
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  if (!words.length) return false;

  // Multi-word names ("max bot"): plain substring on the normalized text.
  if (needle.includes(' ')) return normalizePhrase(text).includes(needle);

  for (const word of words) {
    if (word === needle) return true;
    // One typo's worth of slack, but only for names long enough that a
    // single edit can't reach a different common word. At 3 characters
    // "amy" is one edit from "any", "may" and "am".
    if (needle.length >= 5 && editDistance(word, needle, 1) <= 1) return true;
  }
  return false;
}

const CLASSIFY_PROMPT = (name, transcript, utterance) => (
  `You are a fast pre-filter for a Discord voice bot named "${name}".\n\n`
  + 'Decide ONE thing: does the latest line refer to the bot by name?\n\n'
  + 'This is a speech transcript, so the name is often misheard. Treat '
  + `anything that plausibly SOUNDS like "${name}" as the name — misspellings, `
  + 'split into two words, or a similar-sounding real word. Someone saying '
  + `"hey am ee" or "hey Emmy" to a bot called Amy is saying its name.\n\n`
  + 'Say yes whether the bot is being spoken TO or merely spoken ABOUT — '
  + 'something else decides which. You are only answering "did its name come '
  + 'up".\n\n'
  + 'Say no when the name does not appear at all, or when a similar word is '
  + `clearly an ordinary word in context and not the name ("any of them", `
  + '"am I right", a different person\'s name).\n\n'
  + `Recent conversation:\n${transcript || '(nothing yet)'}\n\n`
  + `LATEST LINE: ${utterance}\n\n`
  + 'Reply with ONLY this JSON and nothing else:\n'
  + '{"mentioned": true or false, "heard": "the words you read as the name, or empty"}'
);

/** Pull the verdict out of a model reply that may be fenced or chatty. */
export function parseVerdict(reply) {
  if (!reply) return null;
  const text = String(reply).replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed?.mentioned !== 'boolean') return null;
  return { mentioned: parsed.mentioned, heard: String(parsed.heard || '').slice(0, 60) };
}

/**
 * Stage 1. Was the bot referred to by name in this utterance?
 *
 * @returns {Promise<{mentioned: boolean, via: 'name'|'classifier'|'none'|'skipped', heard?: string}>}
 *   `via` is for the log line — knowing whether a wake came from the fast
 *   path or the model is the difference between "the classifier is too
 *   eager" and "the name check is too loose" when tuning.
 */
export async function detectMention(guild, channelId, utterance, {
  transcript = '', signal, now = Date.now(),
} = {}) {
  const name = botName(guild.client, guild.id);

  // Fast path: no model call, no latency, no budget.
  if (looksLikeMention(utterance, name)) return { mentioned: true, via: 'name' };

  const words = normalizePhrase(utterance).split(' ').filter(Boolean);
  if (words.length < MIN_WORDS_FOR_CLASSIFIER) return { mentioned: false, via: 'none' };
  if (utterance.length > MAX_CHARS_FOR_CLASSIFIER) return { mentioned: false, via: 'none' };

  const since = now - (lastClassify.get(String(channelId)) || 0);
  if (since < CLASSIFY_COOLDOWN_MS) return { mentioned: false, via: 'skipped' };
  lastClassify.set(String(channelId), now);

  let reply;
  try {
    reply = await chat([{ role: 'user', content: CLASSIFY_PROMPT(name, transcript, utterance) }], {
      model: db.getSetting(guild.id, 'ai_utility_model') || undefined,
      temperature: 0.0,
      maxTokens: 60,
      background: true,
      signal,
    });
  } catch (err) {
    // Budget exhausted, no API key, provider down — none of which should take
    // voice down with them. The fast path above already ran, so a clear
    // "hey amy" still works; this only gives up the misheard ones.
    if (err instanceof OpenRouterError) {
      console.warn('[mention] classifier unavailable:', err.message);
      return { mentioned: false, via: 'none' };
    }
    if (err?.name === 'AbortError') return { mentioned: false, via: 'none' };
    throw err;
  }

  const verdict = parseVerdict(reply);
  if (!verdict) {
    console.warn(`[mention] unparseable classifier reply: ${String(reply).slice(0, 120)}`);
    return { mentioned: false, via: 'none' };
  }
  return { mentioned: verdict.mentioned, via: 'classifier', heard: verdict.heard };
}

/** Test seam — the cooldown map is module state. */
export function resetCooldowns() {
  lastClassify.clear();
}
