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
// the other; two passes each get one job.
//
// Stage 1 is itself in two parts, and that is a cost decision rather than an
// accuracy one. A model call per utterance sounds fine until a busy voice
// channel produces one every few seconds: the first version of this shipped
// that way and drained the shared hourly background budget within the hour,
// taking memory consolidation, de-escalation and proactive classification
// down with it. So a local phonetic gate runs first and the model only sees
// utterances that contain something plausibly name-shaped.
import { chat, OpenRouterError, bgBudgetRemaining } from './openrouter.js';
import { InsufficientCreditsError } from './credits/index.js';
import { normalizePhrase } from './phrases.js';
import { botName } from './botName.js';
import * as db from './db.js';

/** Utterances shorter than this are not worth a model call. */
const MIN_WORDS_FOR_CLASSIFIER = 2;
/** Nor are very long ones — a monologue is not someone calling out a name. */
const MAX_CHARS_FOR_CLASSIFIER = 600;
/** Per-channel floor between classifier calls. */
export const CLASSIFY_COOLDOWN_MS = 8_000;
/**
 * Background calls left in the hour below which detection stops classifying.
 *
 * Detection is the highest-frequency background caller and the least
 * important: missing a mention costs one unanswered "hey Amy", while missing
 * a memory consolidation loses what the bot knows. When the pool runs low,
 * detection is what should starve.
 */
export const BUDGET_RESERVE = 60;
/** Reasoning models spend completion tokens thinking before they answer. 60
 *  tokens was enough for the answer and nothing else, so every reply came
 *  back either empty or truncated mid-thought. */
const CLASSIFY_MAX_TOKENS = 400;

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
 * The forms of the name worth matching against.
 *
 * The given name matters as much as the full one: a bot whose Discord display
 * name is "Amy Smith" is called "Amy" by everyone in the room, and matching
 * only the full phrase means the fast path never fires for it — which is
 * exactly what happened in production.
 */
export function nameForms(name) {
  const full = normalizePhrase(name);
  if (!full) return { full: '', forms: [] };
  const tokens = full.split(' ').filter(Boolean);
  const forms = [full];
  // Only the first token — a surname is not what anyone says out loud.
  if (tokens.length > 1 && tokens[0].length >= 3) forms.push(tokens[0]);
  return { full, forms };
}

/**
 * High-precision local check: does the name appear more or less verbatim?
 * A hit here skips the model entirely — zero latency, zero spend.
 */
export function looksLikeMention(text, name) {
  const { forms } = nameForms(name);
  if (!forms.length) return false;
  const normalized = normalizePhrase(text);
  if (!normalized) return false;
  const words = normalized.split(' ').filter(Boolean);

  for (const form of forms) {
    if (form.includes(' ')) {
      if (normalized.includes(form)) return true;
      continue;
    }
    for (const word of words) {
      if (word === form) return true;
      // One typo's worth of slack, but only for names long enough that a
      // single edit cannot reach a different common word. At 3 characters
      // "amy" is one edit from "any", "may" and "am".
      if (form.length >= 5 && editDistance(word, form, 1) <= 1) return true;
    }
  }
  return false;
}

/**
 * A crude phonetic key: what a word sounds like, stripped of the spelling.
 *
 * Edit distance is the obvious tool here and it is the wrong one. The whole
 * problem is words that SOUND alike while being spelled differently, and
 * "aimee" is three edits from "amy" — further than "any", which sounds
 * nothing like it. Any threshold loose enough to catch the real mishearings
 * admits half the language first.
 *
 * So: drop the vowels (y included — it is a vowel in every name this has to
 * handle), fold the consonants that transcribers routinely swap, and collapse
 * doubles. "amy", "aim", "aimee", "emmy" and "ay me" all reduce to "m".
 */
export function phoneticKey(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Low-precision local gate: could anything here PLAUSIBLY be the name once a
 * transcriber has had its way with it?
 *
 * This is what keeps the model call rare, and rare is not optional — the
 * first version had no gate at all, classified every utterance, and drained
 * the shared hourly background budget inside an hour, taking memory
 * consolidation and de-escalation down with it.
 *
 * It over-admits on purpose: for a short name like "Amy" the key is "m", so
 * "me", "my" and "am" get through too. Rejecting those is the classifier's
 * job and its prompt names that exact case. What matters is that the vast
 * majority of speech — "what time is the meeting" — has no matching key
 * anywhere and never costs anything.
 */
export function mightBeMention(text, name) {
  const { forms } = nameForms(name);
  if (!forms.length) return false;
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  if (!words.length) return false;

  for (const form of forms) {
    const key = phoneticKey(form);
    if (!key) continue;
    for (let i = 0; i < words.length; i += 1) {
      // A length sanity bound alongside the key, so a one-letter key like "m"
      // does not match a long word that merely happens to reduce to it.
      if (phoneticKey(words[i]) === key && Math.abs(words[i].length - form.length) <= 2) {
        return true;
      }
      // The name arriving as two words — "aim ee" for "Amy" — which is the
      // single most common way a short name is mangled.
      if (i + 1 < words.length) {
        const joined = words[i] + words[i + 1];
        if (phoneticKey(joined) === key && Math.abs(joined.length - form.length) <= 3) {
          return true;
        }
      }
    }
  }
  return false;
}

const CLASSIFY_PROMPT = (name, transcript, utterance) => (
  `You are a fast pre-filter for a Discord voice bot named "${name}".\n\n`
  + 'Decide ONE thing: does the latest line refer to the bot by name?\n\n'
  + 'This is a speech transcript, so the name is often misheard. Treat '
  + `anything that plausibly SOUNDS like "${name}" as the name — misspellings, `
  + 'split into two words, or a similar-sounding real word. Someone saying '
  + '"hey am ee" or "hey Emmy" to a bot called Amy is saying its name. The '
  + 'given name alone counts; nobody says a bot\'s full name out loud.\n\n'
  + 'Say YES whether the bot is being spoken TO or merely spoken ABOUT — '
  + 'something else decides which. You are only answering "did its name come '
  + 'up".\n\n'
  + 'Say NO when the name does not appear at all, or when a similar word is '
  + 'clearly an ordinary word in context and not the name ("any of them", '
  + '"am I right", a different person\'s name).\n\n'
  + `Recent conversation:\n${transcript || '(nothing yet)'}\n\n`
  + `LATEST LINE: ${utterance}\n\n`
  + 'Think as briefly as you like, then END your reply with exactly these two '
  + 'lines and nothing after them:\n'
  + 'HEARD: <the words you read as the name, or NONE>\n'
  + 'ANSWER: YES or NO'
);

/**
 * Pull the verdict out of a model reply.
 *
 * Deliberately forgiving about everything before the answer. The free model
 * pool is full of reasoning models that narrate their thinking first ("The
 * user wants me to act as a pre-filter..."), and a parser that demanded clean
 * JSON rejected every one of them.
 */
export function parseVerdict(reply) {
  if (!reply) return null;
  const text = String(reply).replace(/```(?:json)?/gi, '').trim();
  if (!text) return null;

  // Preferred: the two-line tail the prompt asks for. Last match wins — a
  // model that reasons out loud may write "ANSWER: YES" mid-thought before
  // settling on no.
  const answers = [...text.matchAll(/ANSWER\s*[:=]\s*(YES|NO|TRUE|FALSE)\b/gi)];
  if (answers.length) {
    const verdict = answers[answers.length - 1][1].toUpperCase();
    const heard = [...text.matchAll(/HEARD\s*[:=]\s*(.+)/gi)].pop()?.[1] || '';
    return {
      mentioned: verdict === 'YES' || verdict === 'TRUE',
      heard: /^none$/i.test(heard.trim()) ? '' : heard.trim().replace(/^["']|["'],?$/g, '').slice(0, 60),
    };
  }

  // Older JSON shape, still accepted so a model that ignores the format but
  // answers correctly is not thrown away.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (typeof parsed?.mentioned === 'boolean') {
        return { mentioned: parsed.mentioned, heard: String(parsed.heard || '').slice(0, 60) };
      }
    } catch { /* fall through to the bare-word check */ }
  }

  // Last resort: a bare yes/no as the entire reply.
  if (/^(yes|true)\b\W*$/i.test(text)) return { mentioned: true, heard: '' };
  if (/^(no|false)\b\W*$/i.test(text)) return { mentioned: false, heard: '' };
  return null;
}

/**
 * Stage 1. Was the bot referred to by name in this utterance?
 *
 * @returns {Promise<{mentioned: boolean, via: string, heard?: string}>}
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

  // Cheapest guards first.
  const words = normalizePhrase(utterance).split(' ').filter(Boolean);
  if (words.length < MIN_WORDS_FOR_CLASSIFIER) return { mentioned: false, via: 'none' };
  if (utterance.length > MAX_CHARS_FOR_CLASSIFIER) return { mentioned: false, via: 'none' };

  // Nothing name-shaped anywhere — the overwhelmingly common case, and the
  // one that has to stay free.
  if (!mightBeMention(utterance, name)) return { mentioned: false, via: 'no-candidate' };

  // Leave the rest of the pool for the callers that cannot be re-run.
  if (bgBudgetRemaining(now) <= BUDGET_RESERVE) {
    return { mentioned: false, via: 'budget-reserved' };
  }

  const since = now - (lastClassify.get(String(channelId)) || 0);
  if (since < CLASSIFY_COOLDOWN_MS) return { mentioned: false, via: 'skipped' };
  lastClassify.set(String(channelId), now);

  let reply;
  try {
    reply = await chat([{ role: 'user', content: CLASSIFY_PROMPT(name, transcript, utterance) }], {
      model: db.getSetting(guild.id, 'ai_utility_model') || undefined,
      temperature: 0.0,
      maxTokens: CLASSIFY_MAX_TOKENS,
      background: true,
      signal,
      guildId: guild.id,
    });
  } catch (err) {
    // Budget exhausted, out of credit, no API key, provider down — none of
    // which should take voice down with them. The fast path above already
    // ran, so a clear "hey amy" still works; this only gives up the misheard
    // ones.
    if (err instanceof InsufficientCreditsError) return { mentioned: false, via: 'no-credit' };
    if (err instanceof OpenRouterError) {
      console.warn('[mention] classifier unavailable:', err.message);
      return { mentioned: false, via: 'none' };
    }
    if (err?.name === 'AbortError') return { mentioned: false, via: 'none' };
    throw err;
  }

  const verdict = parseVerdict(reply);
  if (!verdict) {
    console.warn(`[mention] unparseable classifier reply: ${JSON.stringify(String(reply).slice(0, 200))}`);
    return { mentioned: false, via: 'none' };
  }
  return { mentioned: verdict.mentioned, via: 'classifier', heard: verdict.heard };
}

/** Test seam — the cooldown map is module state. */
export function resetCooldowns() {
  lastClassify.clear();
}
