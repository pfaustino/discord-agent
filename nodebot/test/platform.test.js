// The platform: the product catalog orders are validated against, customer
// accounts, the order pipeline, and the staff API that issues credit.
//
// The HTTP half runs against a real listening server with a fake discord.js
// client, same as web.test.js — routing, auth, cookies and serialization all
// exercised the way a browser exercises them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../src/db.js';
import * as accounts from '../src/platform/accounts.js';
import * as orders from '../src/platform/orders.js';
import * as ledger from '../src/credits/ledger.js';
import { CAPABILITY_TIER, validateOrder, requiredTier } from '../src/platform/catalog.js';
import { createDashboard } from '../src/web/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-platform-'));
    db.initDb(path.join(dir, 'test.db'));
    try {
      await fn();
    } finally {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/* ── The catalog ────────────────────────────────────────────────────────── */

test('every capability is sold at the same tier the site advertises', () => {
  // A capability listed at one tier on the pricing page and validated at
  // another here means selling something we then refuse to switch on.
  const source = readFileSync(path.join(HERE, '../../site/js/catalog.js'), 'utf8');
  const re = /id: '([a-z0-9-]+)',((?:(?!id:)[\s\S])*?)tier: '(hobby|core|voice|autonomy)'/g;
  const seen = new Set();
  let match = re.exec(source);
  while (match) {
    const [, id, , tier] = match;
    seen.add(id);
    assert.equal(
      CAPABILITY_TIER[id], tier,
      `${id} is ${tier} on the site and ${CAPABILITY_TIER[id]} in the bot`,
    );
    match = re.exec(source);
  }
  for (const id of Object.keys(CAPABILITY_TIER)) {
    assert.ok(seen.has(id), `${id} is validated here but missing from the site catalog`);
  }
});

test('the required tier is the highest any chosen capability needs', () => {
  assert.equal(requiredTier(['mod-commands', 'automod']), 'hobby');
  assert.equal(requiredTier(['mod-commands', 'persona']), 'core');
  assert.equal(requiredTier(['persona', 'voice-join']), 'voice');
  assert.equal(requiredTier(['persona', 'voice-join', 'pressure']), 'autonomy');
  assert.equal(requiredTier([]), 'hobby');
});

test('a capability above the chosen tier is rejected', () => {
  const result = validateOrder({ tier: 'core', modules: ['chat', 'voice-join'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /voice-join needs the voice tier/);
  assert.equal(result.requiredTier, 'voice');
});

test('a capability that cannot stand alone is rejected', () => {
  // Affordable at this tier, but meaningless without what it depends on —
  // worth catching at submission rather than on the onboarding call.
  const result = validateOrder({ tier: 'voice', modules: ['chat', 'wake'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /wake needs voice-join/);
});

test('a coherent order validates', () => {
  const result = validateOrder({
    tier: 'voice',
    modules: ['mod-commands', 'automod', 'chat', 'persona', 'voice-join', 'wake', 'tts'],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('an unknown capability is rejected rather than ignored', () => {
  const result = validateOrder({ tier: 'autonomy', modules: ['telepathy'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /Unknown capability: telepathy/);
});

/* ── Accounts ───────────────────────────────────────────────────────────── */

test('a password round-trips and a wrong one does not', () => {
  const hash = accounts.hashPassword('correct horse battery');
  assert.equal(accounts.verifyPassword('correct horse battery', hash), true);
  assert.equal(accounts.verifyPassword('correct horse batterz', hash), false);
  assert.equal(accounts.verifyPassword('', hash), false);
});

test('the same password hashes differently every time', () => {
  // Distinct salts — one rainbow table must not cover every account at once.
  assert.notEqual(accounts.hashPassword('same password'), accounts.hashPassword('same password'));
});

test('a malformed stored hash is refused rather than crashing', () => {
  assert.equal(accounts.verifyPassword('x', ''), false);
  assert.equal(accounts.verifyPassword('x', 'plaintext'), false);
  assert.equal(accounts.verifyPassword('x', 'scrypt$zz$zz'), false);
});

test('creating an account and signing in works', withDb(() => {
  const created = accounts.createAccount({
    name: 'Harbour Guild', email: 'Admin@Harbour.Example', password: 'a-long-passphrase',
  });
  assert.equal(created.email, 'admin@harbour.example', 'email is normalized');
  assert.equal(created.venue, 'managed');
  assert.ok(accounts.authenticate('admin@harbour.example', 'a-long-passphrase'));
  assert.equal(accounts.authenticate('admin@harbour.example', 'wrong'), null);
  assert.equal(accounts.authenticate('nobody@harbour.example', 'a-long-passphrase'), null);
}));

test('accounts are refused for bad input', withDb(() => {
  const ok = { name: 'X', email: 'x@y.test', password: 'a-long-passphrase' };
  assert.throws(() => accounts.createAccount({ ...ok, email: 'nope' }), /email address/);
  assert.throws(() => accounts.createAccount({ ...ok, password: 'short' }), /at least 10/);
  assert.throws(() => accounts.createAccount({ ...ok, name: '  ' }), /name is required/);
  assert.throws(() => accounts.createAccount({ ...ok, venue: 'freemium' }), /Unknown venue/);
  accounts.createAccount(ok);
  assert.throws(() => accounts.createAccount(ok), /already exists/);
}));

test('the public view of an account never carries the password hash', withDb(() => {
  const created = accounts.createAccount({
    name: 'X', email: 'x@y.test', password: 'a-long-passphrase',
  });
  const view = accounts.publicAccount(created);
  assert.equal('password_hash' in view, false);
  assert.equal('passwordHash' in view, false);
  assert.equal(view.credits, 0);
}));

test('a session token round-trips and a tampered one does not', withDb(() => {
  const token = accounts.createSession('acct_x');
  assert.equal(accounts.readSession(token).accountId, 'acct_x');
  assert.equal(accounts.readSession(`${token}x`), null);
  // The account id is inside the signed payload, so it cannot be swapped.
  const [expiry, , signature] = token.split('.');
  assert.equal(accounts.readSession(`${expiry}.acct_someone_else.${signature}`), null);
  assert.equal(accounts.readSession('1000000000.acct_x.deadbeef'), null);
}));

/* ── Orders ─────────────────────────────────────────────────────────────── */

const ORDER = {
  venue: 'managed',
  accountName: 'Harbour Guild',
  email: 'admin@harbour.example',
  serverName: 'Harbour Guild',
  botName: 'Skipper',
  tier: 'core',
  modules: ['mod-commands', 'automod', 'chat', 'persona'],
};

test('a valid order lands validated', withDb(() => {
  const { request, validation } = orders.submitOrder(ORDER);
  assert.equal(validation.ok, true);
  assert.equal(request.stage, 'validated');
  assert.equal(request.botName, 'Skipper');
  assert.deepEqual(request.modules, ORDER.modules);
}));

test('an invalid order is still recorded, with its problems attached', withDb(() => {
  // Somebody who mis-picked is the customer most worth talking to. Throwing
  // the form away to show them a red box loses the lead with it.
  const { request, validation } = orders.submitOrder({
    ...ORDER, modules: [...ORDER.modules, 'voice-join'],
  });
  assert.equal(validation.ok, false);
  assert.equal(request.stage, 'submitted');
  assert.match(request.details.validationErrors.join(' '), /voice-join needs the voice tier/);
}));

test('an order with no tier gets the one its choices need', withDb(() => {
  const { request } = orders.submitOrder({ ...ORDER, tier: undefined, modules: ['chat', 'voice-join'] });
  assert.equal(request.tier, 'voice');
}));

test('an order without a server name is refused', withDb(() => {
  assert.throws(() => orders.submitOrder({ ...ORDER, serverName: '' }), /Which Discord server/);
}));

test('the pipeline only ever moves forward, one stage at a time', withDb(() => {
  const { request } = orders.submitOrder(ORDER);
  assert.equal(request.stage, 'validated');
  // Skipping review is refused: it is where enterprise key handover happens,
  // and we do not provision against keys we did not receive.
  assert.throws(() => orders.advance(request.id, 'provisioning'), /Cannot skip/);
  assert.throws(() => orders.advance(request.id, 'submitted'), /Already at validated/);
  assert.throws(() => orders.advance(request.id, 'sideways'), /Unknown stage/);
  assert.equal(orders.advance(request.id, 'review').stage, 'review');
  assert.equal(orders.advance(request.id, 'provisioning').stage, 'provisioning');
  assert.equal(orders.advance(request.id, 'ready').stage, 'ready');
}));

test('a rejected order cannot be walked back onto the happy path', withDb(() => {
  const { request } = orders.submitOrder(ORDER);
  orders.advance(request.id, 'rejected');
  assert.equal(orders.getRequest(request.id).stage, 'rejected');
  assert.throws(() => orders.advance(request.id, 'review'), /was rejected/);
  assert.throws(() => orders.approve(request.id), /was rejected/);
}));

test('approving twice provisions one server, not two', withDb(() => {
  // A double-clicked approve button must not end up minting two bots.
  const account = accounts.createAccount({
    name: 'Harbour', email: 'a@b.test', password: 'a-long-passphrase',
  });
  const { request } = orders.submitOrder({ ...ORDER, accountId: account.id });
  orders.advance(request.id, 'review');
  const first = orders.approve(request.id);
  const second = orders.approve(request.id);
  assert.equal(first.id, second.id);
  assert.equal(orders.listServers(account.id).length, 1);
  assert.equal(orders.getRequest(request.id).stage, 'provisioning');
}));

test('an order cannot be approved before it has been reviewed', withDb(() => {
  const account = accounts.createAccount({
    name: 'H', email: 'a@b.test', password: 'a-long-passphrase',
  });
  const { request } = orders.submitOrder({ ...ORDER, accountId: account.id });
  assert.throws(() => orders.approve(request.id), /take it through review/);
}));

test('attaching a Discord server is what makes billing possible', withDb(() => {
  const account = accounts.createAccount({
    name: 'H', email: 'a@b.test', password: 'a-long-passphrase',
  });
  const { request } = orders.submitOrder({ ...ORDER, accountId: account.id });
  orders.advance(request.id, 'review');
  const server = orders.approve(request.id);

  // Until the guild is attached, nothing the bot does traces back to anyone.
  assert.equal(ledger.accountForGuild('4242'), null);
  orders.attachGuild(server.id, '4242');
  assert.equal(ledger.accountForGuild('4242').account.id, account.id);
  // And ready needs the attachment, not the other way round.
  assert.equal(orders.setServerStatus(server.id, 'ready').status, 'ready');
  // The bot going live finishes the order too — a queue that still shows work
  // outstanding for a bot that is already answering stops being believed.
  assert.equal(orders.getRequest(request.id).stage, 'ready');
}));

test('two bots cannot claim the same Discord server', withDb(() => {
  // Otherwise "which account does this guild bill?" has two answers.
  const account = accounts.createAccount({
    name: 'H', email: 'a@b.test', password: 'a-long-passphrase',
  });
  const mk = (name) => {
    const { request } = orders.submitOrder({ ...ORDER, serverName: name, accountId: account.id });
    orders.advance(request.id, 'review');
    return orders.approve(request.id);
  };
  const one = mk('One');
  const two = mk('Two');
  orders.attachGuild(one.id, '4242');
  assert.throws(() => orders.attachGuild(two.id, '4242'), /already attached/);
}));

test('a server cannot be marked ready before it has a Discord server', withDb(() => {
  const account = accounts.createAccount({
    name: 'H', email: 'a@b.test', password: 'a-long-passphrase',
  });
  const { request } = orders.submitOrder({ ...ORDER, accountId: account.id });
  orders.advance(request.id, 'review');
  const server = orders.approve(request.id);
  assert.throws(() => orders.setServerStatus(server.id, 'ready'), /Attach the Discord server/);
}));

test('the queue says why each order needs a person', withDb(() => {
  const { request: managed } = orders.submitOrder(ORDER);
  const { request: enterprise } = orders.submitOrder({ ...ORDER, venue: 'enterprise' });
  assert.match(orders.needsHuman(managed), /schedule the build session/);
  assert.match(orders.needsHuman(enterprise), /Key handover/);
}));

/* ── The API ────────────────────────────────────────────────────────────── */

function fakeClient() {
  const map = new Map();
  map.filter = () => map;
  map.some = () => false;
  map.map = () => [];
  return {
    isReady: () => true,
    user: { id: '999', username: 'Max', displayAvatarURL: () => 'http://avatar' },
    ws: { ping: 1 },
    guilds: { cache: map },
  };
}

async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodebot-platform-api-'));
  db.initDb(path.join(dir, 'test.db'));
  const server = createDashboard(fakeClient());
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const call = async (method, urlPath, { body, cookie } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    const setCookie = res.headers.get('set-cookie') || '';
    return { status: res.status, body: json, cookie: setCookie.split(';')[0] };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SIGNUP = { name: 'Harbour Guild', email: 'admin@harbour.example', password: 'a-long-passphrase' };

test('sign up, then read your own account back', () => withServer(async (call) => {
  const signup = await call('POST', '/api/platform/signup', { body: SIGNUP });
  assert.equal(signup.status, 200);
  assert.ok(signup.cookie.startsWith('platform_session='));

  const me = await call('GET', '/api/platform/me', { cookie: signup.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.account.email, 'admin@harbour.example');
  assert.equal(me.body.credits.balance, 0);
  assert.equal(me.body.credits.daysRemaining, null, 'no usage yet means no answer, not Infinity');
  assert.deepEqual(me.body.servers, []);
}));

test('the account API needs a session', () => withServer(async (call) => {
  assert.equal((await call('GET', '/api/platform/me')).status, 401);
  assert.equal((await call('GET', '/api/platform/usage')).status, 401);
}));

test('a dashboard cookie is not a platform session', () => withServer(async (call) => {
  // The person running a Discord server and the person paying for it are
  // frequently not the same human; neither login stands in for the other.
  const { createToken } = await import('../src/web/auth.js');
  const res = await call('GET', '/api/platform/me', { cookie: `session=${createToken('creator', '1')}` });
  assert.equal(res.status, 401);
}));

test('signing in with the wrong password is refused without saying which field', () => withServer(async (call) => {
  await call('POST', '/api/platform/signup', { body: SIGNUP });
  const wrongPass = await call('POST', '/api/platform/signin', {
    body: { email: SIGNUP.email, password: 'nope-nope-nope' },
  });
  const wrongUser = await call('POST', '/api/platform/signin', {
    body: { email: 'ghost@harbour.example', password: 'a-long-passphrase' },
  });
  assert.equal(wrongPass.status, 401);
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongPass.body.detail, wrongUser.body.detail);
}));

test('the catalog is public, so the order form can render before sign-up', () => withServer(async (call) => {
  const res = await call('GET', '/api/platform/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.body.tiers.length, 4);
  assert.equal(res.body.capabilities.chat, 'hobby');
  assert.ok(res.body.rates.some((r) => r.id === 'reply-standard'));
  assert.ok(res.body.packs.every((p) => typeof p.savingPct === 'number'));
}));

test('an order can be placed without an account', () => withServer(async (call) => {
  // Making somebody sign up before they can tell you what they want is how
  // you lose the order.
  const res = await call('POST', '/api/platform/orders', { body: ORDER });
  assert.equal(res.status, 200);
  assert.ok(res.body.requestId);
  assert.equal(res.body.validation.ok, true);
}));

test('the staff queue is closed to customers', () => withServer(async (call) => {
  const signup = await call('POST', '/api/platform/signup', { body: SIGNUP });
  const res = await call('GET', '/api/platform/admin/requests', { cookie: signup.cookie });
  assert.equal(res.status, 403);
  assert.equal((await call('GET', '/api/platform/admin/requests')).status, 401);
}));

/** Sign up, then promote to staff directly — the bootstrap an operator does
 *  with PLATFORM_STAFF_EMAILS on a real deployment. */
async function staffSession(call, email = 'staff@us.example') {
  const signup = await call('POST', '/api/platform/signup', {
    body: { name: 'Staff', email, password: 'a-long-passphrase' },
  });
  const account = accounts.accountByEmail(email);
  accounts.setStaff(account.id, true);
  return { cookie: signup.cookie, accountId: account.id };
}

test('staff can see the queue and walk an order through to a bot', () => withServer(async (call) => {
  const staff = await staffSession(call);
  const customer = await call('POST', '/api/platform/signup', { body: SIGNUP });
  const order = await call('POST', '/api/platform/orders', {
    body: ORDER, cookie: customer.cookie,
  });

  const queue = await call('GET', '/api/platform/admin/requests', { cookie: staff.cookie });
  assert.equal(queue.status, 200);
  const mine = queue.body.requests.find((r) => r.id === order.body.requestId);
  assert.ok(mine.needsHuman, 'the queue says why it needs a person');

  const advanced = await call('POST', `/api/platform/admin/requests/${mine.id}/advance`, {
    body: { stage: 'review' }, cookie: staff.cookie,
  });
  assert.equal(advanced.body.request.stage, 'review');

  const approved = await call('POST', `/api/platform/admin/requests/${mine.id}/approve`, {
    body: {}, cookie: staff.cookie,
  });
  assert.equal(approved.status, 200);
  const serverId = approved.body.server.id;

  const attached = await call('POST', `/api/platform/admin/servers/${serverId}/guild`, {
    body: { guildId: '4242' }, cookie: staff.cookie,
  });
  assert.equal(attached.body.server.guildId, '4242');

  const ready = await call('POST', `/api/platform/admin/servers/${serverId}/status`, {
    body: { status: 'ready' }, cookie: staff.cookie,
  });
  assert.equal(ready.body.server.status, 'ready');

  const me = await call('GET', '/api/platform/me', { cookie: customer.cookie });
  assert.equal(me.body.servers.length, 1);
  assert.equal(me.body.servers[0].status, 'ready');
}));

test('staff issue credit against a payment reference, and it shows up', () => withServer(async (call) => {
  const staff = await staffSession(call);
  const customer = await call('POST', '/api/platform/signup', { body: SIGNUP });
  const account = accounts.accountByEmail(SIGNUP.email);

  const issued = await call('POST', `/api/platform/admin/accounts/${account.id}/credits`, {
    body: { packId: 'pack-50', reference: 'transfer 8812' }, cookie: staff.cookie,
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.balance, 30000);

  const me = await call('GET', '/api/platform/me', { cookie: customer.cookie });
  assert.equal(me.body.credits.balance, 30000);

  const grants = await call('GET', '/api/platform/grants', { cookie: customer.cookie });
  assert.equal(grants.body.grants[0].reference, 'transfer 8812');
  assert.equal(grants.body.grants[0].source, 'manual');
}));

test('credit cannot be issued without saying how it was paid', () => withServer(async (call) => {
  // An issued credit with no reference is indistinguishable from an accident.
  const staff = await staffSession(call);
  await call('POST', '/api/platform/signup', { body: SIGNUP });
  const account = accounts.accountByEmail(SIGNUP.email);
  const res = await call('POST', `/api/platform/admin/accounts/${account.id}/credits`, {
    body: { credits: 5000 }, cookie: staff.cookie,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.detail, /payment reference/);
}));

test('issuing the same grant id twice credits once', () => withServer(async (call) => {
  const staff = await staffSession(call);
  await call('POST', '/api/platform/signup', { body: SIGNUP });
  const account = accounts.accountByEmail(SIGNUP.email);
  const payload = {
    body: { credits: 5000, reference: 'inv-1', grantId: 'grant_fixed' }, cookie: staff.cookie,
  };
  const first = await call('POST', `/api/platform/admin/accounts/${account.id}/credits`, payload);
  const second = await call('POST', `/api/platform/admin/accounts/${account.id}/credits`, payload);
  assert.equal(first.body.granted, true);
  assert.equal(second.body.granted, false);
  assert.equal(second.body.balance, 5000);
}));

test('usage a bot generates shows up on the customer dashboard', () => withServer(async (call) => {
  const staff = await staffSession(call);
  const customer = await call('POST', '/api/platform/signup', { body: SIGNUP });
  const account = accounts.accountByEmail(SIGNUP.email);
  await call('POST', `/api/platform/admin/accounts/${account.id}/credits`, {
    body: { credits: 1000, reference: 'inv-1' }, cookie: staff.cookie,
  });

  // What the bot's metering does, end to end.
  const { request } = orders.submitOrder({ ...ORDER, accountId: account.id });
  orders.advance(request.id, 'review');
  const server = orders.approve(request.id);
  orders.attachGuild(server.id, '4242');

  const credits = await import('../src/credits/index.js');
  const ctx = credits.gate('4242');
  credits.meter(ctx, { kind: 'reply-standard' });
  credits.meter(ctx, { kind: 'background', quantity: 5 });

  const me = await call('GET', '/api/platform/me', { cookie: customer.cookie });
  assert.equal(me.body.credits.balance, 997, '1000 less one reply and five background calls');

  const usage = await call('GET', '/api/platform/usage?days=7', { cookie: customer.cookie });
  assert.equal(usage.body.daily.length, 7);
  assert.equal(usage.body.daily.at(-1).credits, 3);
  assert.equal(usage.body.byServer[0].serverId, server.id);
}));
