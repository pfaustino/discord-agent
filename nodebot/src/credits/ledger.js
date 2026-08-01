// The credit ledger: what an account has, what its bots spent, and how
// credit gets issued.
//
// Storage lives here rather than in db.js because these tables are the
// platform's, not the bot's — but they share db.js's one connection (see
// getDb there for why that matters).
//
// Everything internal is integer millicredits. See credits/rates.js.
import { randomBytes } from 'node:crypto';
import { getDb } from '../db.js';
import {
  costMilli, toCredits, toMilli, packById,
} from './rates.js';

const now = () => Math.floor(Date.now() / 1000);

export function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** Run `fn` inside a transaction, rolling back if it throws.
 *
 * node:sqlite has no transaction() helper, and metering genuinely needs one:
 * a usage event written without its matching decrement is free work, and a
 * decrement without its event is an unexplainable balance. */
function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

export function getAccount(accountId) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(String(accountId)) || null;
}

/**
 * Which account a Discord guild bills to, or null if it bills to nobody.
 *
 * Null is the normal answer for a self-hosted install and for an enterprise
 * customer running on their own keys — neither is metered, and neither needs
 * a flag set to stay that way. Only a guild deliberately registered as a
 * managed server gets billed.
 */
export function accountForGuild(guildId) {
  const row = getDb().prepare(`
    SELECT s.id AS server_id, s.status AS server_status, a.*
      FROM platform_servers s
      JOIN accounts a ON a.id = s.account_id
     WHERE s.guild_id = ?
  `).get(String(guildId));
  if (!row) return null;
  const { server_id: serverId, server_status: serverStatus, ...account } = row;
  return { account, serverId, serverStatus };
}

export function balanceMilli(accountId) {
  const row = getDb().prepare('SELECT credits_milli FROM accounts WHERE id = ?').get(String(accountId));
  return row ? row.credits_milli : 0;
}

export function balanceCredits(accountId) {
  return toCredits(balanceMilli(accountId));
}

/* ── Spending ─────────────────────────────────────────────────────────────── */

/**
 * Is there enough balance to START work?
 *
 * The spec is deliberate that this is a gate on starting, not a ceiling on
 * finishing: metering happens after the provider call returns, from the real
 * token or duration count, never estimated up front. So a call can complete
 * that takes the balance to zero. Overshooting by one call is far cheaper
 * than pre-authorising every request.
 */
export function canSpend(accountId) {
  return balanceMilli(accountId) > 0;
}

/**
 * Record one billable action and take it out of the balance, atomically.
 *
 * The balance floors at zero and the shortfall is written off — the customer
 * never carries a debt to us. Both numbers are kept: `credits_milli` is the
 * full frozen price of the action and `charged_milli` is what the balance
 * actually lost, so the write-off is a visible, summable number rather than
 * revenue that quietly evaporates.
 *
 * `credits_milli` is frozen at write time on purpose. Rates change; a
 * customer's past invoice must not.
 *
 * `charge: false` records the event at full list price but takes nothing —
 * that is the enterprise (bring-your-own-keys) case, where the provider bill
 * is the customer's own and we report usage back rather than billing it.
 *
 * @returns {{creditsMilli: number, chargedMilli: number, balanceMilli: number}}
 */
export function spend({
  accountId, serverId = null, guildId = null, kind,
  quantity = 1, providerRef = null, meta = null, charge = true,
}) {
  const creditsMilli = costMilli(kind, quantity);
  return transaction((db) => {
    const row = db.prepare('SELECT credits_milli FROM accounts WHERE id = ?').get(String(accountId));
    if (!row) throw new Error(`no such account: ${accountId}`);
    const chargedMilli = charge
      ? Math.max(0, Math.min(creditsMilli, row.credits_milli))
      : 0;
    const after = row.credits_milli - chargedMilli;
    db.prepare('UPDATE accounts SET credits_milli = ?, updated_at = ? WHERE id = ?')
      .run(after, now(), String(accountId));
    db.prepare(`
      INSERT INTO usage_events
        (account_id, server_id, guild_id, kind, quantity,
         credits_milli, charged_milli, provider_ref, meta, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(accountId), serverId ? String(serverId) : null,
      guildId ? String(guildId) : null, String(kind), Number(quantity),
      creditsMilli, chargedMilli, providerRef ? String(providerRef) : null,
      meta ? JSON.stringify(meta) : null, now(),
    );
    return { creditsMilli, chargedMilli, balanceMilli: after };
  });
}

/* ── Issuing credit ───────────────────────────────────────────────────────── */

/**
 * Put credit on an account.
 *
 * There is no checkout behind this yet, by design — a customer pays out of
 * band (invoice, transfer, whatever we agreed) and a member of staff issues
 * the credits against that payment reference. When a payment processor is
 * wired in later it becomes another `source` calling this same function, and
 * nothing downstream changes.
 *
 * Idempotent on `id`. That is what makes a double-clicked "issue" button
 * safe, and it is the same property a payment webhook will need when one
 * exists — a processor that retries a delivered event must not double-credit.
 *
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {number} [opts.credits]  explicit amount; or give a packId
 * @param {string} [opts.packId]   sell a catalog pack, recording what was sold
 * @param {string} [opts.id]       idempotency key; generated when omitted
 * @returns {{granted: boolean, grantId: string, credits: number, balanceMilli: number}}
 *   `granted: false` means this id was already applied and nothing changed.
 */
export function issue({
  accountId, credits = null, packId = null, source = 'manual',
  reference = null, issuedBy = null, note = null, id = null,
}) {
  const pack = packId ? packById(packId) : null;
  if (packId && !pack) throw new Error(`unknown pack: ${packId}`);
  const amount = credits != null ? Number(credits) : pack?.credits;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('issue() needs a positive credit amount or a valid packId');
  }
  const creditsMilli = toMilli(amount);
  const grantId = id || newId('grant');

  return transaction((db) => {
    const existing = db.prepare('SELECT id FROM credit_grants WHERE id = ?').get(grantId);
    if (existing) {
      const row = db.prepare('SELECT credits_milli FROM accounts WHERE id = ?').get(String(accountId));
      return {
        granted: false, grantId, credits: amount, balanceMilli: row?.credits_milli ?? 0,
      };
    }
    const account = db.prepare('SELECT credits_milli FROM accounts WHERE id = ?').get(String(accountId));
    if (!account) throw new Error(`no such account: ${accountId}`);
    db.prepare(`
      INSERT INTO credit_grants
        (id, account_id, credits_milli, pack_id, amount_cents,
         source, reference, issued_by, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grantId, String(accountId), creditsMilli, packId,
      pack ? Math.round(pack.price * 100) : null, String(source),
      reference, issuedBy, note, now(),
    );
    const after = account.credits_milli + creditsMilli;
    db.prepare('UPDATE accounts SET credits_milli = ?, updated_at = ? WHERE id = ?')
      .run(after, now(), String(accountId));
    return {
      granted: true, grantId, credits: amount, balanceMilli: after,
    };
  });
}

export function grantsFor(accountId, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM credit_grants WHERE account_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(String(accountId), Number(limit));
}

/* ── Reporting ────────────────────────────────────────────────────────────── */

const DAY = 86400;

/**
 * Daily credit spend for the last `days` days, oldest first.
 *
 * Pre-aggregated deliberately: a busy server generates thousands of usage
 * events a day and the chart wants thirty numbers. Days with no usage are
 * filled in as zero, so the chart has no gaps to reason about.
 */
export function usageDaily(accountId, days = 30) {
  const since = now() - DAY * days;
  const rows = getDb().prepare(`
    SELECT (at / ${DAY}) AS bucket, kind,
           SUM(quantity) AS quantity, SUM(credits_milli) AS credits_milli
      FROM usage_events
     WHERE account_id = ? AND at >= ?
     GROUP BY bucket, kind
  `).all(String(accountId), since);

  const byBucket = new Map();
  for (const row of rows) {
    const entry = byBucket.get(row.bucket) || { creditsMilli: 0, kinds: {} };
    entry.creditsMilli += row.credits_milli;
    entry.kinds[row.kind] = {
      quantity: row.quantity,
      credits: toCredits(row.credits_milli),
    };
    byBucket.set(row.bucket, entry);
  }

  const endBucket = Math.floor(now() / DAY);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const bucket = endBucket - i;
    const entry = byBucket.get(bucket) || { creditsMilli: 0, kinds: {} };
    out.push({
      day: bucket * DAY * 1000,
      credits: toCredits(entry.creditsMilli),
      kinds: entry.kinds,
    });
  }
  return out;
}

export function usageByKind(accountId, days = 30) {
  const since = now() - DAY * days;
  const rows = getDb().prepare(`
    SELECT kind, SUM(quantity) AS quantity, SUM(credits_milli) AS credits_milli
      FROM usage_events WHERE account_id = ? AND at >= ? GROUP BY kind
  `).all(String(accountId), since);
  return rows.map((r) => ({
    kind: r.kind, quantity: r.quantity, credits: toCredits(r.credits_milli),
  }));
}

export function usageByServer(accountId, days = 30) {
  const since = now() - DAY * days;
  const rows = getDb().prepare(`
    SELECT server_id, SUM(credits_milli) AS credits_milli
      FROM usage_events WHERE account_id = ? AND at >= ? GROUP BY server_id
  `).all(String(accountId), since);
  return rows.map((r) => ({ serverId: r.server_id, credits: toCredits(r.credits_milli) }));
}

/** Mean daily spend in credits over the last `days` days. */
export function burnRate(accountId, days = 7) {
  const rows = usageDaily(accountId, days);
  if (!rows.length) return 0;
  return rows.reduce((sum, r) => sum + r.credits, 0) / rows.length;
}

/** Whole days of balance left at the current burn rate. Infinity if idle. */
export function daysRemaining(accountId, days = 7) {
  const rate = burnRate(accountId, days);
  if (rate <= 0) return Infinity;
  return Math.floor(balanceCredits(accountId) / rate);
}

/** Total written off — billed for, but the balance had nothing left to take.
 *  Overshoot is expected and accepted; a large number here is not.
 *
 *  Managed accounts only. On an enterprise account every event is recorded
 *  with `charge: false`, so this would report the whole reported-back usage
 *  as a write-off, which is meaningless there — callers gate on venue. */
export function writtenOffCredits(accountId, days = 30) {
  const since = now() - DAY * days;
  const row = getDb().prepare(`
    SELECT SUM(credits_milli - charged_milli) AS milli
      FROM usage_events WHERE account_id = ? AND at >= ?
  `).get(String(accountId), since);
  return toCredits(row?.milli || 0);
}
