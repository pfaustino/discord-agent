// Orders and the servers they turn into.
//
// An order is the form a customer fills in: which venue, what they want the
// bot to do, and enough about their Discord server for someone here to run
// the onboarding session with them. It is not a checkout — nothing is
// provisioned by submitting it. It is the start of a conversation, and the
// pipeline below is the state of that conversation.
import { getDb } from '../db.js';
import { newId } from '../credits/ledger.js';
import { validateOrder, requiredTier, isTier } from './catalog.js';

const now = () => Math.floor(Date.now() / 1000);

/**
 * The provisioning pipeline.
 *
 * `auto` marks the stages that need nobody: submitted and validated run
 * synchronously at submission, so a customer finds out immediately that what
 * they picked is impossible rather than on the call two days later.
 *
 * Everything from `review` on is moved by a person, including the two the
 * original spec had as automatic. That is honest about two things at once:
 * there is no code here that registers a Discord application or mints a
 * token, and this is a supported service — someone sits down with the
 * customer and builds the bot with them. When provisioning is genuinely
 * automated, `auto` here is what changes.
 */
export const STAGES = [
  {
    id: 'submitted',
    name: 'Submitted',
    auto: true,
    detail: 'Order received, plan and capabilities recorded.',
  },
  {
    id: 'validated',
    name: 'Validated',
    auto: true,
    detail: 'Capability set checked against the tier; impossible combinations rejected.',
  },
  {
    id: 'review',
    name: 'Review',
    auto: false,
    detail: 'We get in a room with you and build it out together. '
      + 'Enterprise key handover happens here.',
  },
  {
    id: 'provisioning',
    name: 'Provisioning',
    auto: false,
    detail: 'Discord application registered, token minted, settings written.',
  },
  {
    id: 'ready',
    name: 'Ready',
    auto: false,
    detail: 'Invite link issued and dashboard access granted.',
  },
];

export const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
/** Terminal, and deliberately outside the ladder — a rejected order has no
 *  position on it, and treating it as "before submitted" would let it be
 *  advanced back onto the happy path by an off-by-one. */
export const REJECTED = 'rejected';

export class OrderError extends Error {}

function parse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function serializeRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    venue: row.venue,
    accountName: row.account_name,
    email: row.email,
    serverName: row.server_name,
    botName: row.bot_name,
    tier: row.tier,
    modules: parse(row.modules, []),
    details: parse(row.details, {}),
    stage: row.stage,
    notes: row.notes,
    submittedAt: row.submitted_at * 1000,
    updatedAt: row.updated_at * 1000,
  };
}

/**
 * Record an order and run the automatic stages.
 *
 * A failing validation is NOT an error — the order is still recorded, at the
 * `submitted` stage with its problems attached. Someone who mis-picked a
 * capability set is exactly the customer most worth talking to, and throwing
 * their form away to show them a red box would lose the lead along with it.
 *
 * @returns {{request: object, validation: {ok: boolean, errors: string[]}}}
 */
export function submitOrder({
  accountId = null, venue = 'managed', accountName = '', email = '',
  serverName = '', botName = '', tier = null, modules = [], details = {},
}) {
  if (!['managed', 'enterprise'].includes(venue)) throw new OrderError(`Unknown venue: ${venue}`);
  if (!String(serverName).trim()) throw new OrderError('Which Discord server is this for?');
  const list = [...new Set((modules || []).map(String))];
  // A tier the customer did not pick defaults to the one their choices need,
  // rather than failing the form over a field the builder computes anyway.
  const chosenTier = isTier(tier) ? tier : requiredTier(list);
  const validation = validateOrder({ tier: chosenTier, modules: list });

  const id = newId('req');
  const stamp = now();
  getDb().prepare(`
    INSERT INTO platform_requests
      (id, account_id, venue, account_name, email, server_name, bot_name,
       tier, modules, details, stage, notes, submitted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
  `).run(
    id, accountId, venue, String(accountName || '').trim(),
    String(email || '').trim().toLowerCase(), String(serverName).trim(),
    String(botName || '').trim() || null, chosenTier, JSON.stringify(list),
    JSON.stringify({ ...details, validationErrors: validation.errors }),
    validation.ok ? 'validated' : 'submitted', stamp, stamp,
  );
  return { request: serializeRequest(getRequest(id)), validation };
}

export function getRequest(id) {
  return getDb().prepare('SELECT * FROM platform_requests WHERE id = ?').get(String(id)) || null;
}

export function listRequests({ stage = null, accountId = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (stage) { where.push('stage = ?'); args.push(String(stage)); }
  if (accountId) { where.push('account_id = ?'); args.push(String(accountId)); }
  const sql = `SELECT * FROM platform_requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY submitted_at DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, Number(limit)).map(serializeRequest);
}

/** Which orders need a person, and why. Drives the staff queue's filter. */
export function needsHuman(request) {
  if (request.stage === REJECTED || request.stage === 'ready') return null;
  if (request.venue === 'enterprise') return 'Key handover and contract';
  if (request.stage === 'review') return 'Capability set confirmation';
  if (request.stage === 'validated') return 'Ready to schedule the build session';
  if (request.stage === 'submitted') return 'Capability set does not validate';
  return 'Provisioning in progress';
}

/** Edit what a customer is actually getting, before it is built. */
export function updateRequest(id, { tier, modules, notes, botName } = {}) {
  const existing = getRequest(id);
  if (!existing) throw new OrderError('No such order');
  const nextModules = modules ? [...new Set(modules.map(String))] : parse(existing.modules, []);
  const nextTier = tier !== undefined && isTier(tier) ? tier : existing.tier;
  const validation = validateOrder({ tier: nextTier, modules: nextModules });
  const details = parse(existing.details, {});
  getDb().prepare(`
    UPDATE platform_requests
       SET tier = ?, modules = ?, notes = ?, bot_name = ?, details = ?, updated_at = ?
     WHERE id = ?
  `).run(
    nextTier, JSON.stringify(nextModules),
    notes !== undefined ? String(notes) : existing.notes,
    botName !== undefined ? String(botName).trim() || null : existing.bot_name,
    JSON.stringify({ ...details, validationErrors: validation.errors }),
    now(), String(id),
  );
  return { request: serializeRequest(getRequest(id)), validation };
}

/**
 * Move an order along the pipeline.
 *
 * Only ever forwards, one stage at a time, and never out of a rejection.
 * Skipping is refused rather than allowed-with-a-warning because of what the
 * skipped stage is: `review` is where enterprise key handover happens, and
 * we do not provision against keys we did not receive.
 */
export function advance(id, toStage) {
  const existing = getRequest(id);
  if (!existing) throw new OrderError('No such order');
  if (existing.stage === REJECTED) throw new OrderError('That order was rejected.');
  if (toStage === REJECTED) {
    getDb().prepare('UPDATE platform_requests SET stage = ?, updated_at = ? WHERE id = ?')
      .run(REJECTED, now(), String(id));
    return serializeRequest(getRequest(id));
  }
  const from = STAGE_INDEX[existing.stage];
  const to = STAGE_INDEX[toStage];
  if (to === undefined) throw new OrderError(`Unknown stage: ${toStage}`);
  if (to <= from) throw new OrderError(`Already at ${existing.stage}.`);
  if (to > from + 1) {
    throw new OrderError(`Cannot skip from ${existing.stage} to ${toStage} — `
      + `go through ${STAGES[from + 1].id} first.`);
  }
  if (toStage === 'validated') {
    const validation = validateOrder({
      tier: existing.tier, modules: parse(existing.modules, []),
    });
    if (!validation.ok) throw new OrderError(validation.errors.join('; '));
  }
  getDb().prepare('UPDATE platform_requests SET stage = ?, updated_at = ? WHERE id = ?')
    .run(toStage, now(), String(id));
  return serializeRequest(getRequest(id));
}

/* ── Servers ──────────────────────────────────────────────────────────────── */

export function serializeServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    requestId: row.request_id,
    guildId: row.guild_id,
    name: row.name,
    botName: row.bot_name,
    tier: row.tier,
    modules: parse(row.modules, []),
    status: row.status,
    provisionedAt: row.provisioned_at ? row.provisioned_at * 1000 : null,
    createdAt: row.created_at * 1000,
  };
}

export function getServer(id) {
  return getDb().prepare('SELECT * FROM platform_servers WHERE id = ?').get(String(id)) || null;
}

export function listServers(accountId) {
  return getDb().prepare('SELECT * FROM platform_servers WHERE account_id = ? ORDER BY created_at')
    .all(String(accountId)).map(serializeServer);
}

/**
 * Turn an approved order into a server record, and move it to provisioning.
 *
 * Idempotent on the order id — a second call returns the server the first one
 * made rather than a second server. That is enforced by a unique index rather
 * than by this check alone, so two concurrent clicks cannot both find nothing
 * and both insert.
 */
export function approve(requestId, { accountId = null } = {}) {
  const request = getRequest(requestId);
  if (!request) throw new OrderError('No such order');
  if (request.stage === REJECTED) throw new OrderError('That order was rejected.');
  if (STAGE_INDEX[request.stage] < STAGE_INDEX.review) {
    throw new OrderError(`Order is still at ${request.stage} — take it through review first.`);
  }
  const existing = getDb().prepare('SELECT * FROM platform_servers WHERE request_id = ?')
    .get(String(requestId));
  if (existing) return serializeServer(existing);

  const owner = accountId || request.account_id;
  if (!owner) throw new OrderError('This order has no account attached yet.');
  const id = newId('srv');
  try {
    getDb().prepare(`
      INSERT INTO platform_servers
        (id, account_id, request_id, guild_id, name, bot_name, tier, modules,
         status, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'provisioning', ?)
    `).run(id, owner, String(requestId), request.server_name, request.bot_name,
    request.tier, request.modules, now());
  } catch (err) {
    // Lost the race against a concurrent approve — the other one's server is
    // the right answer, not an error.
    const raced = getDb().prepare('SELECT * FROM platform_servers WHERE request_id = ?')
      .get(String(requestId));
    if (raced) return serializeServer(raced);
    throw err;
  }
  if (request.stage === 'review') advance(requestId, 'provisioning');
  return serializeServer(getServer(id));
}

/**
 * Point a server row at the Discord guild the bot actually joined.
 *
 * This is the moment billing starts working: until a guild id is attached,
 * nothing the bot does can be traced back to an account, so nothing is
 * metered. Attaching it is therefore the last provisioning step, not the
 * first.
 */
export function attachGuild(serverId, guildId) {
  const server = getServer(serverId);
  if (!server) throw new OrderError('No such server');
  const claimed = getDb().prepare('SELECT id FROM platform_servers WHERE guild_id = ? AND id != ?')
    .get(String(guildId), String(serverId));
  if (claimed) throw new OrderError('That Discord server is already attached to another bot.');
  getDb().prepare('UPDATE platform_servers SET guild_id = ? WHERE id = ?')
    .run(String(guildId), String(serverId));
  return serializeServer(getServer(serverId));
}

const SERVER_STATUSES = ['provisioning', 'ready', 'suspended'];

export function setServerStatus(serverId, status) {
  if (!SERVER_STATUSES.includes(status)) throw new OrderError(`Unknown status: ${status}`);
  const server = getServer(serverId);
  if (!server) throw new OrderError('No such server');
  if (status === 'ready' && !server.guild_id) {
    throw new OrderError('Attach the Discord server before marking this ready.');
  }
  getDb().prepare('UPDATE platform_servers SET status = ?, provisioned_at = ? WHERE id = ?')
    .run(status, status === 'ready' ? (server.provisioned_at || now()) : server.provisioned_at,
      String(serverId));
  return serializeServer(getServer(serverId));
}
