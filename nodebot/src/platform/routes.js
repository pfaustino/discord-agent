// The platform API: sign-up, orders, balance and usage for customers, and
// the queue and credit issuance for staff.
//
// Mounted by web/server.js alongside the Discord dashboard's own routes. They
// share a port and a database but not an identity: a dashboard session says
// what someone may do to a Discord server, a platform session says which
// customer account they are. See platform/accounts.js.
//
// Auth is declared per route the same way the dashboard's is, and fails the
// same way — a route that declares nothing is refused rather than served.
import { HttpError } from '../web/httpError.js';
import { parseCookies } from '../web/auth.js';
import { PLATFORM_STAFF_EMAILS } from '../config.js';
import * as accounts from './accounts.js';
import * as orders from './orders.js';
import { TIERS, CAPABILITY_TIER, CAPABILITY_REQUIRES, validateOrder } from './catalog.js';
import * as ledger from '../credits/ledger.js';
import { CREDIT_RATES, CREDIT_PACKS, packSavingPct } from '../credits/rates.js';

/**
 * Who is making this request, or null.
 *
 * Staff-ness is recomputed here on every request rather than read from the
 * token, so revoking it takes effect immediately. `PLATFORM_STAFF_EMAILS`
 * exists to solve the bootstrap: the first staff account cannot be promoted
 * by an existing staff account, because there isn't one.
 */
export function resolvePlatformSession(req) {
  const token = parseCookies(req.headers.cookie)[accounts.SESSION_COOKIE];
  const session = accounts.readSession(token);
  if (!session) return null;
  let row;
  try {
    row = accounts.getAccount(session.accountId);
  } catch {
    return null; // database not up — treated as signed out, never as staff
  }
  if (!row) return null;
  const staffEmails = PLATFORM_STAFF_EMAILS.map((e) => e.toLowerCase());
  return {
    accountId: row.id,
    account: row,
    isStaff: Boolean(row.is_staff) || staffEmails.includes(String(row.email).toLowerCase()),
  };
}

const bad = (detail) => new HttpError(400, detail);

/** Turn the domain layer's refusals into 400s, and let anything else 500. */
function guard(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof accounts.AccountError || err instanceof orders.OrderError) {
      throw bad(err.message);
    }
    throw err;
  }
}

function accountPayload(accountId) {
  const row = accounts.getAccount(accountId);
  if (!row) throw new HttpError(404, 'Account not found');
  const managed = row.venue !== 'enterprise';
  const runway = ledger.daysRemaining(accountId);
  return {
    account: accounts.publicAccount(row),
    servers: orders.listServers(accountId),
    credits: {
      balance: ledger.balanceCredits(accountId),
      burnRate: Math.round(ledger.burnRate(accountId) * 100) / 100,
      // JSON has no Infinity; null reads as "no answer yet" on the dashboard,
      // which is the truth for an account that has not spent anything.
      daysRemaining: Number.isFinite(runway) ? runway : null,
      writtenOff: managed ? ledger.writtenOffCredits(accountId) : 0,
      metered: managed,
    },
  };
}

export function platformRoutes() {
  return [
    /* ── Public ─────────────────────────────────────────────────────────── */

    // Everything the order form and the pricing page need to render, from the
    // same definitions the bot bills and validates against.
    ['GET', '/api/platform/catalog', async () => ({
      tiers: TIERS,
      capabilities: CAPABILITY_TIER,
      requires: CAPABILITY_REQUIRES,
      stages: orders.STAGES,
      rates: CREDIT_RATES,
      packs: CREDIT_PACKS.map((p) => ({ ...p, savingPct: packSavingPct(p) })),
    }), { open: true }],

    ['POST', '/api/platform/signup', async ({ body, res, sendJson }) => {
      const account = guard(() => accounts.createAccount({
        name: body.name,
        email: body.email,
        password: body.password,
        venue: body.venue || 'managed',
      }));
      sendJson(res, 200, { account: accounts.publicAccount(account) }, {
        'Set-Cookie': accounts.sessionCookie(accounts.createSession(account.id)),
      });
    }, { open: true }],

    ['POST', '/api/platform/signin', async ({ body, res, sendJson }) => {
      const account = accounts.authenticate(body.email, body.password);
      if (!account) throw new HttpError(401, 'Wrong email or password.');
      sendJson(res, 200, { account: accounts.publicAccount(account) }, {
        'Set-Cookie': accounts.sessionCookie(accounts.createSession(account.id)),
      });
    }, { open: true }],

    ['POST', '/api/platform/signout', async ({ res, sendJson }) => {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': accounts.clearSessionCookie() });
    }, { open: true }],

    // Open on purpose. Somebody filling in the order form has not necessarily
    // made an account yet, and making them stop and sign up first is how you
    // lose the order. If they are signed in it is attached to them; if not,
    // the email on the form is how it gets matched up later.
    ['POST', '/api/platform/orders', async ({ body, req }) => {
      const session = resolvePlatformSession(req);
      const result = guard(() => orders.submitOrder({
        accountId: session?.accountId || null,
        venue: body.venue || 'managed',
        accountName: body.accountName,
        email: body.email || session?.account.email,
        serverName: body.serverName,
        botName: body.botName,
        tier: body.tier,
        modules: body.modules,
        details: {
          accent: body.accent,
          persona: body.persona,
          wake: body.wake,
          voiceModel: body.voiceModel,
          followupSec: body.followupSec,
          discord: body.discord,
          notes: body.notes,
          keys: body.keys,
        },
      }));
      return { requestId: result.request.id, ...result };
    }, { open: true }],

    // Check an order's capability set without committing to it, so the
    // builder can show the problem while it is still being made.
    ['POST', '/api/platform/orders/validate', async ({ body }) => (
      validateOrder({ tier: body.tier, modules: body.modules || [] })
    ), { open: true }],

    /* ── Customer ───────────────────────────────────────────────────────── */

    ['GET', '/api/platform/me', async ({ platform }) => accountPayload(platform.accountId),
      { account: 'any' }],

    ['GET', '/api/platform/usage', async ({ platform, query }) => {
      const days = Math.max(1, Math.min(parseInt(query.days, 10) || 30, 365));
      return {
        daily: ledger.usageDaily(platform.accountId, days),
        byKind: ledger.usageByKind(platform.accountId, days),
        byServer: ledger.usageByServer(platform.accountId, days),
      };
    }, { account: 'any' }],

    ['GET', '/api/platform/grants', async ({ platform }) => ({
      grants: ledger.grantsFor(platform.accountId).map((g) => ({
        id: g.id,
        credits: g.credits_milli / 1000,
        packId: g.pack_id,
        source: g.source,
        reference: g.reference,
        note: g.note,
        at: g.created_at * 1000,
      })),
    }), { account: 'any' }],

    ['GET', '/api/platform/orders', async ({ platform }) => ({
      orders: orders.listRequests({ accountId: platform.accountId }),
    }), { account: 'any' }],

    ['PUT', '/api/platform/autotopup', async ({ platform, body }) => {
      // Recorded, not yet acted on: charging a saved card off-session needs a
      // payment processor, and there isn't one. Storing the preference now
      // means the threshold is already there to warn against.
      guard(() => accounts.setAutoTopUp(platform.accountId, {
        enabled: Boolean(body.enabled),
        threshold: Math.max(0, Number(body.threshold) || 0),
        packId: body.packId || null,
      }));
      return accountPayload(platform.accountId);
    }, { account: 'any' }],

    /* ── Staff ──────────────────────────────────────────────────────────── */

    ['GET', '/api/platform/admin/requests', async ({ query }) => {
      const list = orders.listRequests({ stage: query.stage || null });
      return { requests: list.map((r) => ({ ...r, needsHuman: orders.needsHuman(r) })) };
    }, { account: 'staff' }],

    ['PUT', '/api/platform/admin/requests/:id', async ({ params, body }) => (
      guard(() => orders.updateRequest(params.id, {
        tier: body.tier,
        modules: body.modules,
        notes: body.notes,
        botName: body.botName,
      }))
    ), { account: 'staff' }],

    ['POST', '/api/platform/admin/requests/:id/advance', async ({ params, body }) => ({
      request: guard(() => orders.advance(params.id, body.stage)),
    }), { account: 'staff' }],

    ['POST', '/api/platform/admin/requests/:id/approve', async ({ params, body }) => ({
      server: guard(() => orders.approve(params.id, { accountId: body.accountId })),
    }), { account: 'staff' }],

    ['GET', '/api/platform/admin/accounts', async () => ({
      accounts: accounts.listAccounts().map((row) => ({
        ...accounts.publicAccount(row),
        servers: orders.listServers(row.id).length,
      })),
    }), { account: 'staff' }],

    ['GET', '/api/platform/admin/accounts/:id', async ({ params }) => ({
      ...accountPayload(params.id),
      orders: orders.listRequests({ accountId: params.id }),
      grants: ledger.grantsFor(params.id).map((g) => ({
        id: g.id,
        credits: g.credits_milli / 1000,
        source: g.source,
        reference: g.reference,
        note: g.note,
        issuedBy: g.issued_by,
        at: g.created_at * 1000,
      })),
    }), { account: 'staff' }],

    // Issue credit against a payment taken out of band. This is the whole
    // funding path until a processor is wired in: the customer pays however
    // we agreed, and somebody here records it with the reference that proves
    // it. `grantId` from the caller makes a retry safe.
    ['POST', '/api/platform/admin/accounts/:id/credits', async ({ params, body, platform }) => {
      if (!accounts.getAccount(params.id)) throw new HttpError(404, 'Account not found');
      if (!String(body.reference || '').trim()) {
        // Not bureaucracy: an issued credit with no payment reference is
        // indistinguishable from an accident or a favour, and the one thing
        // this ledger has to survive is somebody asking "why does this
        // account have credit".
        throw bad('A payment reference is required — how was this paid?');
      }
      const result = guard(() => ledger.issue({
        accountId: params.id,
        credits: body.credits != null ? Number(body.credits) : null,
        packId: body.packId || null,
        source: 'manual',
        reference: String(body.reference).trim(),
        issuedBy: platform.account.email,
        note: body.note ? String(body.note) : null,
        id: body.grantId || null,
      }));
      return { ...result, balance: result.balanceMilli / 1000 };
    }, { account: 'staff' }],

    ['POST', '/api/platform/admin/servers/:id/guild', async ({ params, body }) => {
      if (!String(body.guildId || '').trim()) throw bad('A Discord server id is required.');
      return { server: guard(() => orders.attachGuild(params.id, String(body.guildId).trim())) };
    }, { account: 'staff' }],

    ['POST', '/api/platform/admin/servers/:id/status', async ({ params, body }) => ({
      server: guard(() => orders.setServerStatus(params.id, body.status)),
    }), { account: 'staff' }],

    ['POST', '/api/platform/admin/accounts/:id/staff', async ({ params, body }) => {
      if (!accounts.getAccount(params.id)) throw new HttpError(404, 'Account not found');
      guard(() => accounts.setStaff(params.id, Boolean(body.isStaff)));
      return { ok: true };
    }, { account: 'staff' }],
  ];
}

export { platformRoutes as default };
