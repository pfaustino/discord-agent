// Rerouting around a backend that has started refusing.
//
// Two very different situations, handled deliberately differently:
//
//   Conversational work — somebody just spoke to her and is waiting. She says
//   what happened, offers three alternatives, and switches when told to. The
//   model changing mid-conversation is something the room should know about,
//   and on a managed account it can change what the reply costs.
//
//   Background work — memory consolidation, signal classification,
//   de-escalation. Nobody is listening at 3am when consolidation fails, so
//   asking is a no-op that just loses the work. It rotates on its own and
//   logs the switch.
//
// ── Why the answer-matching here is deterministic ──────────────────────────
//
// The whole feature fires when the model backend is unavailable, so nothing
// in the reply path can use a model to interpret "switch to B" — that is the
// thing that is broken. Every phrase match below is plain string work, and
// the offer is keyed A/B/C precisely because single letters survive a bad
// transcription better than model names do.
import * as db from '../db.js';
import { OPENROUTER_MODEL, OPENROUTER_UTILITY_MODEL, OPENROUTER_FALLBACK_MODELS } from '../config.js';
import * as catalog from './catalog.js';
import { replyKindForModel, rateFor } from '../credits/rates.js';

/** Which stored setting each role reads and writes. */
const ROLES = {
  chat: { setting: 'ai_model', previous: 'ai_model_previous', fallback: () => OPENROUTER_MODEL },
  utility: {
    setting: 'ai_utility_model',
    previous: 'ai_utility_model_previous',
    fallback: () => OPENROUTER_UTILITY_MODEL,
  },
};

export const isRole = (role) => Object.hasOwn(ROLES, String(role));

/** The model a role is currently pointed at, resolving the env fallback. */
export function currentModel(guildId, role) {
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown model role: ${role}`);
  return db.getSetting(guildId, spec.setting) || spec.fallback();
}

/* ── Cooldowns ────────────────────────────────────────────────────────────

   A model that just returned 429 is parked for a while rather than removed:
   rate limits lift, and a model that is merely busy right now is still a
   perfectly good backend in ten minutes. Kept in memory on purpose — a
   restart clearing the cooldowns is the right failure direction, since the
   worst case is one wasted call that re-parks it. */

export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** A daily quota (OpenRouter's free pool) will not lift in fifteen minutes.
 *  Park those until tomorrow instead of thrashing against them all day. */
export const DAILY_QUOTA_COOLDOWN_MS = 6 * 3600_000;
/** An upstream 5xx. Might be a blip on a good model, might be a model that
 *  can never answer us — park it briefly either way so the next call goes
 *  somewhere else instead of hammering the same broken provider. */
export const UPSTREAM_ERROR_COOLDOWN_MS = 5 * 60_000;

const cooling = new Map(); // modelId → { until, reason }

/** OpenRouter says which kind of limit was hit in the message body. A daily
 *  free-model quota and a per-minute burst limit both arrive as 429 but need
 *  very different cooldowns. */
export function cooldownFor(message = '') {
  return /per-?day|daily|free-models-per-day/i.test(String(message))
    ? DAILY_QUOTA_COOLDOWN_MS
    : DEFAULT_COOLDOWN_MS;
}

export function markUnavailable(modelId, { reason = '', nowMs = Date.now(), ms } = {}) {
  if (!modelId) return;
  const duration = ms ?? cooldownFor(reason);
  cooling.set(String(modelId), { until: nowMs + duration, reason });
  const mins = Math.round(duration / 60_000);
  console.warn(`[backends] parking ${modelId} for ${mins}m — ${reason || 'rate limited'}`);
}

export function isAvailable(modelId, nowMs = Date.now()) {
  const entry = cooling.get(String(modelId));
  if (!entry) return true;
  if (entry.until <= nowMs) { cooling.delete(String(modelId)); return true; }
  return false;
}

export function clearCooldowns() {
  cooling.clear();
}

/* ── Building the shortlist ───────────────────────────────────────────────

   Three options that deliberately span tiers rather than three of the
   cheapest. Three free models are three models that hit the same daily quota
   on the same day — which is the exact failure this is routing around. */

/** Vendors whose first-party endpoints are the stable ones on OpenRouter.
 *  The free pool is the flaky one; that is the whole reason this exists. */
const STEADY_VENDORS = ['anthropic/', 'openai/', 'google/', 'mistralai/', 'meta-llama/'];

const totalPrice = (m) => (m.promptPrice || 0) + (m.completionPrice || 0);
const isSteady = (m) => STEADY_VENDORS.some((v) => m.id.startsWith(v));

/**
 * Up to three alternatives for a role, cheapest-tier first.
 *
 * `OPENROUTER_FALLBACK_MODELS` overrides the automatic pick entirely — set it
 * when you would rather curate the list than have it chosen for you.
 */
export function shortlist(guildId, role, {
  nowMs = Date.now(), limit = 3, curated = OPENROUTER_FALLBACK_MODELS,
} = {}) {
  const current = currentModel(guildId, role);
  const needsTools = role === 'chat';

  const pool = catalog.list({ toolsOnly: needsTools })
    .filter((m) => m.id !== current && isAvailable(m.id, nowMs));

  if (curated.length) {
    const known = new Map(pool.map((m) => [m.id, m]));
    return curated
      .map((id) => known.get(id))
      .filter(Boolean)
      .slice(0, limit)
      .map((m) => describe(m, role));
  }

  const picked = [];
  const take = (candidates) => {
    const best = candidates.find((m) => !picked.some((p) => p.id === m.id));
    if (best) picked.push(best);
  };

  const free = pool.filter(catalog.isFree)
    .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  const paid = pool.filter((m) => !catalog.isFree(m))
    .sort((a, b) => totalPrice(a) - totalPrice(b));

  take(free);                              // free — costs nothing, may be capped
  take(paid);                              // cheapest paid — no daily quota
  take(paid.filter(isSteady));             // steady vendor — the safe one

  // Backfill if a tier had nothing, so she still offers three where possible.
  for (const m of [...paid, ...free]) {
    if (picked.length >= limit) break;
    take([m]);
  }
  return picked.slice(0, limit).map((m) => describe(m, role));
}

/** A spoken-friendly label: "Anthropic: Claude 3.5 Haiku" → "Claude 3.5 Haiku". */
export function spokenLabel(name, id) {
  const text = String(name || id || '');
  const afterVendor = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  return afterVendor.replace(/\(free\)/ig, '').trim() || String(id);
}

/** What this option costs the customer, in the rate card's own terms. */
export function costNote(model, role) {
  if (role !== 'chat') return `${rateFor('background').credits} credits per call`;
  const rate = rateFor(replyKindForModel(model.id));
  return `${rate.credits} credits per reply`;
}

function describe(model, role) {
  return {
    id: model.id,
    label: spokenLabel(model.name, model.id),
    free: catalog.isFree(model),
    contextLength: model.contextLength,
    costNote: costNote(model, role),
  };
}

/* ── Switching ────────────────────────────────────────────────────────────── */

export function switchTo(guildId, role, modelId) {
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown model role: ${role}`);
  if (!modelId) throw new Error('a model id is required');
  const from = currentModel(guildId, role);
  if (String(modelId) === from) return { from, to: from, changed: false };
  db.setSetting(guildId, spec.previous, from);
  db.setSetting(guildId, spec.setting, String(modelId));
  console.log(`[backends] ${role} model: ${from} → ${modelId} (guild ${guildId})`);
  return { from, to: String(modelId), changed: true };
}

/** The model this role was on before the last switch, if any. */
export function previousModel(guildId, role) {
  const spec = ROLES[role];
  if (!spec) return null;
  return db.getSetting(guildId, spec.previous) || null;
}

/**
 * Move background work to the next working model, without asking.
 *
 * Returns the switch, or null when there is nothing better to move to — in
 * which case background work stays broken and says so in the log, which is
 * still better than silently pretending it ran.
 */
export function rotateBackground(guildId, { nowMs = Date.now() } = {}) {
  const options = shortlist(guildId, 'utility', { nowMs, limit: 1 });
  if (!options.length) {
    console.warn('[backends] background model is rate limited and no alternative is available');
    return null;
  }
  const result = switchTo(guildId, 'utility', options[0].id);
  console.warn(`[backends] background work rerouted to ${options[0].id} (${options[0].label})`);
  return { ...result, option: options[0] };
}

/**
 * Drop any stored model the catalog says can never answer us.
 *
 * Rotation writes its pick to a setting, so one bad choice outlives the call
 * that made it: before the catalog knew to exclude non-chat models, background
 * work could land on a music generator and return 502 on every call from then
 * on. The failure path recovers from that, but only after burning a call — and
 * it is worth not burning it, because this is knowable in advance.
 *
 * Only acts when the catalog *positively* says the model cannot chat. A model
 * that is simply absent from the catalog is left alone: a hand-set id that
 * OpenRouter does not list is a deliberate choice, not a mistake to correct.
 */
export function evictUnusable({ nowMs = Date.now() } = {}) {
  let rows;
  try {
    rows = db.getDb().prepare(`
      SELECT guild_id, key, value FROM guild_settings
       WHERE key IN ('ai_model', 'ai_utility_model')
    `).all();
  } catch {
    return []; // no database — nothing stored, nothing to evict
  }

  const evicted = [];
  for (const raw of rows) {
    // Settings are stored JSON-encoded, so the column holds `"vendor/model"`
    // rather than the bare id.
    let value;
    try { value = JSON.parse(raw.value); } catch { continue; }
    const row = { ...raw, value };
    const entry = catalog.get(row.value);
    if (!entry || entry.canChat) continue;
    const role = row.key === 'ai_model' ? 'chat' : 'utility';
    console.warn(`[backends] ${row.value} cannot hold a text conversation — `
      + `dropping it as the ${role} model for guild ${row.guild_id}`);
    // Park it too, so the shortlist cannot immediately hand it back. This one
    // is not a rate limit that lifts — nothing about it will be different in
    // an hour — so it is parked for the day rather than for minutes.
    markUnavailable(row.value, { reason: 'not a chat model', nowMs, ms: 24 * 3600_000 });
    const options = shortlist(row.guild_id, role, { nowMs, limit: 1 });
    if (!options.length) {
      console.warn(`[backends] no usable ${role} model to replace ${row.value} with`);
      continue;
    }
    evicted.push({ guildId: row.guild_id, role, ...switchTo(row.guild_id, role, options[0].id) });
  }
  return evicted;
}

/* ── The offer ────────────────────────────────────────────────────────────── */

export const OFFER_TTL_MS = 10 * 60_000;
const offers = new Map(); // guildId → { role, options, at }

export function offer(guildId, role, options, { nowMs = Date.now() } = {}) {
  if (!options?.length) return null;
  const pending = { role, options, at: nowMs };
  offers.set(String(guildId), pending);
  return pending;
}

export function pendingOffer(guildId, nowMs = Date.now()) {
  const pending = offers.get(String(guildId));
  if (!pending) return null;
  if (nowMs - pending.at > OFFER_TTL_MS) { offers.delete(String(guildId)); return null; }
  return pending;
}

export function clearOffer(guildId) {
  offers.delete(String(guildId));
}

/** What she says when the backend goes down. Reads aloud cleanly, which is
 *  the actual constraint — this arrives in a voice channel as often as text. */
export function offerText(model, options) {
  const lines = options.map((o, i) => {
    const letter = String.fromCharCode(97 + i).toUpperCase();
    const price = o.free ? 'free' : o.costNote;
    return `${letter}: ${o.label} — ${price}`;
  });
  return `${model} isn’t answering right now — it’s rate limited. I can switch to:\n`
    + `${lines.join('\n')}\n`
    + 'Say the letter, or "switch back" to undo, or "never mind" to leave it.';
}

const WORD_PICKS = {
  a: 0, b: 1, c: 2, one: 0, two: 1, three: 2, first: 0, second: 1, third: 2,
};

const normalize = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s.\-/]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Interpret a reply to a pending offer, using no model at all.
 *
 * Returns null when there is no pending offer or the text isn't an answer to
 * it — the caller then treats the utterance as an ordinary message. That
 * fall-through matters: somebody who ignores the offer and just keeps talking
 * must not have their sentence eaten by this.
 *
 * @returns {{action:'switch'|'back'|'cancel', model?:string, option?:object}|null}
 */
export function resolveOffer(guildId, text, { nowMs = Date.now() } = {}) {
  const pending = pendingOffer(guildId, nowMs);
  if (!pending) return null;
  const said = normalize(text);
  if (!said) return null;

  if (/\b(never mind|nevermind|no thanks|cancel|leave it|stay|forget it|no)\b/.test(said)) {
    return { action: 'cancel' };
  }
  if (/\b(switch back|go back|revert|undo|put it back)\b/.test(said)) {
    const model = previousModel(guildId, pending.role);
    return model ? { action: 'back', model } : { action: 'cancel' };
  }

  // Letter or ordinal pick — "b", "option b", "the second one", "number two".
  const pick = said.match(/\b(?:option|number|the)?\s*(a|b|c|one|two|three|first|second|third)\b/);
  if (pick && (said.length < 30 || /\b(switch|use|try|go with|pick|choose|option|number)\b/.test(said))) {
    const index = WORD_PICKS[pick[1]];
    const option = pending.options[index];
    if (option) return { action: 'switch', model: option.id, option };
  }

  // Named pick — "switch to haiku", "use gemini". Matched on the distinctive
  // words of the label, because nobody says "anthropic slash claude 3.5 haiku"
  // out loud and a transcriber would mangle it if they did.
  if (/\b(switch|use|try|go with|pick|choose|change)\b/.test(said)) {
    for (const option of pending.options) {
      const words = normalize(option.label).split(' ')
        .filter((w) => w.length >= 4 && !/^\d+(\.\d+)?$/.test(w));
      if (words.some((w) => said.includes(w))) {
        return { action: 'switch', model: option.id, option };
      }
    }
  }
  return null;
}

/** Apply a resolved answer. Returns the sentence she says back. */
export function applyAnswer(guildId, answer) {
  const pending = pendingOffer(guildId);
  const role = pending?.role || 'chat';
  clearOffer(guildId);

  if (answer.action === 'cancel') return 'Leaving it as it is.';
  const result = switchTo(guildId, role, answer.model);
  if (!result.changed) return 'Already on that one.';
  const label = answer.option?.label || answer.model;
  const suffix = answer.option && role === 'chat' ? ` That bills at ${answer.option.costNote}.` : '';
  return answer.action === 'back'
    ? `Switched back to ${label}.`
    : `Switched to ${label}.${suffix}`;
}
