import { test } from 'node:test';
import assert from 'node:assert';
import { preflightChecks } from '../src/preflight.js';

const warnings = (env) => preflightChecks({ secretKey: 'k', cwd: '/app', ...env })
  .filter((f) => f.level === 'warn');

const dbWarning = (env) => warnings(env).find((w) => w.message.startsWith('[db]'));

test('reports the resolved database path', () => {
  const info = preflightChecks({ databasePath: '/data/nodebot/nodebot.db', secretKey: 'k' })
    .find((f) => f.level === 'info');
  assert.match(info.message, /\[db\] using .*nodebot\.db/);
});

test('a database on the mounted volume is clean', () => {
  assert.deepEqual(
    warnings({ databasePath: '/data/nodebot/nodebot.db', volumeMountPath: '/data/nodebot' }),
    [],
  );
});

test('the mount point used directly as the file is accepted', () => {
  assert.equal(
    dbWarning({ databasePath: '/data/nodebot', volumeMountPath: '/data/nodebot' }),
    undefined,
  );
});

test('a relative path is flagged as the container disk', () => {
  const warning = dbWarning({ databasePath: 'nodebot.db', volumeMountPath: '/data/nodebot' });
  assert.match(warning.message, /not an absolute path/);
  assert.match(warning.message, /\/data\/nodebot/);
});

test('an absolute path outside the mounted volume is flagged', () => {
  // The exact production misconfiguration: looks durable, is not.
  const warning = dbWarning({ databasePath: '/data/bot.db', volumeMountPath: '/data/nodebot' });
  assert.match(warning.message, /OUTSIDE it/);
  assert.match(warning.message, /\/data\/nodebot\/nodebot\.db/);
});

test('a sibling prefix is not mistaken for being inside the volume', () => {
  // String-prefix matching would wrongly accept /data/nodebot-old/x.db.
  const warning = dbWarning({ databasePath: '/data/nodebot-old/x.db', volumeMountPath: '/data/nodebot' });
  assert.match(warning.message, /OUTSIDE it/);
});

test('no volume attached means no volume warning', () => {
  assert.equal(dbWarning({ databasePath: '/srv/nodebot.db', volumeMountPath: '' }), undefined);
});

test('a missing SECRET_KEY is flagged as the logout cause', () => {
  const found = preflightChecks({ databasePath: '/data/nodebot/x.db', secretKey: '', volumeMountPath: '/data/nodebot' })
    .filter((f) => f.level === 'warn');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /\[web\] WARNING.*SECRET_KEY/s);
});
