// What the bot calls. Everything in here answers one of two questions:
// "may this work start?" and "what did it cost?".
//
// Bot code should import this module, never ledger.js directly — the ledger
// throws on a missing account and knows nothing about guilds, and both of
// those are wrong at a call site whose real job is answering someone in
// Discord.
import * as ledger from './ledger.js';
import { chatKind } from './rates.js';

export { CREDIT_RATES, CREDIT_PACKS, packById, packSavingPct } from './rates.js';
export { ledger };

/** Thrown by a gate when a managed account has run dry. Distinct from
 *  OpenRouterError so callers can tell "you have no credit" apart from "the
 *  provider is down" — they need very different messages. */
export class InsufficientCreditsError extends Error {
  constructor(message = 'out of credits') {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * The billing context for a guild, or null if this guild bills to nobody.
 *
 * Null covers self-hosted installs and any guild not registered as a managed
 * server — neither is metered and neither is gated. That is the default, and
 * it is what keeps this change invisible to every deployment that isn't
 * running on the platform.
 *
 * Never throws. A billing lookup is not worth failing a Discord reply over,
 * and the bot runs in deployments where these tables are empty.
 */
export function contextFor(guildId) {
  if (!guildId) return null;
  let found;
  try {
    found = ledger.accountForGuild(guildId);
  } catch (err) {
    console.warn('[credits] account lookup failed:', err.message);
    return null;
  }
  if (!found) return null;
  return {
    accountId: found.account.id,
    serverId: found.serverId,
    guildId: String(guildId),
    venue: found.account.venue,
    // Enterprise customers run on their own provider keys — we report their
    // usage back to them but never bill it, and never gate on it.
    charge: found.account.venue !== 'enterprise',
  };
}

/**
 * Refuse to start work when a managed account has no credit left.
 *
 * Only ever called on the AI paths. Moderation, automod, welcome and the
 * slash commands never reach it — they cost nothing to run, and they are what
 * stops a lapsed account turning into an unmoderated server.
 *
 * Fails OPEN. If the ledger itself is broken the bot keeps answering and
 * shouts in the log, because a database problem on our side silencing every
 * customer's bot at once is a far worse outcome than a few unbilled replies.
 *
 * @throws {InsufficientCreditsError}
 */
export function gate(guildId) {
  const ctx = contextFor(guildId);
  if (!ctx || !ctx.charge) return ctx;
  let ok;
  try {
    ok = ledger.canSpend(ctx.accountId);
  } catch (err) {
    console.error('[credits] balance check failed — allowing the call:', err.message);
    return ctx;
  }
  if (!ok) throw new InsufficientCreditsError();
  return ctx;
}

/**
 * Record what a completed provider call cost.
 *
 * Called AFTER the provider returns, from the real token or duration count —
 * never estimated up front. Deliberately swallows its own errors: the work is
 * already done and the reply is already going out, so a ledger write that
 * fails must not turn into a user-visible failure. It is logged at error
 * level because unbilled usage is a real problem, just not this request's.
 *
 * @param {object|null} ctx the value returned by gate()/contextFor()
 */
export function meter(ctx, { kind, quantity = 1, providerRef = null, meta = null }) {
  if (!ctx) return null;
  try {
    return ledger.spend({
      accountId: ctx.accountId,
      serverId: ctx.serverId,
      guildId: ctx.guildId,
      kind,
      quantity,
      providerRef,
      meta,
      charge: ctx.charge,
    });
  } catch (err) {
    console.error(`[credits] failed to meter ${kind} for ${ctx.accountId}:`, err.message);
    return null;
  }
}

/** The billable kind for one chat() call — re-exported so call sites don't
 *  have to know how the rate card names things. */
export { chatKind };

/* ── The out-of-credits notice ──────────────────────────────────────────────

   Once per hour per guild. Without the throttle a dead balance turns the bot
   into a spammer: every mention in a busy server would get its own "you're
   out of credits" reply, which is the single most annoying possible way to
   ask someone for money.

   In-memory on purpose. A restart re-arming the notice is the right failure
   direction — worst case someone is told once more than they needed to be,
   rather than a balance running dry in silence because the flag survived. */
const NOTICE_INTERVAL_MS = 3600_000;
const lastNotice = new Map();

/** True at most once an hour per guild. Records the send as a side effect. */
export function shouldNotify(guildId, nowMs = Date.now()) {
  const key = String(guildId || 'global');
  const previous = lastNotice.get(key);
  if (previous && nowMs - previous < NOTICE_INTERVAL_MS) return false;
  lastNotice.set(key, nowMs);
  return true;
}

/** Testing seam — drops the throttle state. */
export function resetNotices() {
  lastNotice.clear();
}

/** What the bot says when it has run dry. Deliberately not apologetic and
 *  not chatty: it states the situation, says what still works, and stops. */
export const OUT_OF_CREDITS_MESSAGE = 'I’m out of credits, so I can’t reply with AI '
  + 'right now. Moderation, automod and the slash commands all still work. '
  + 'Whoever manages this server can top the balance up from the dashboard.';
