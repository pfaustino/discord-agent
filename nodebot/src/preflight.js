// Startup checks for configuration that is silently wrong.
//
// Both of these fail in the same nasty way: the bot comes up looking
// completely healthy, and the damage only shows later as "my settings keep
// disappearing" or "it logged everyone out again" — with nothing in the logs
// connecting the symptom to the cause.
import path from 'node:path';

/** True when `child` is the mount point itself or sits underneath it. */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {object} env
 * @param {string} env.databasePath  DATABASE_PATH as configured
 * @param {string} env.secretKey     SECRET_KEY as configured
 * @param {string} [env.volumeMountPath]  RAILWAY_VOLUME_MOUNT_PATH, if deployed
 *                                        with a volume attached
 * @param {string} [env.cwd]         resolution base (defaults to process.cwd())
 * @returns {Array<{level: 'warn'|'info', message: string}>}
 */
export function preflightChecks({
  databasePath,
  secretKey,
  volumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '',
  cwd = process.cwd(),
}) {
  const out = [];
  const resolved = path.resolve(cwd, databasePath || 'nodebot.db');
  out.push({ level: 'info', message: `[db] using ${resolved}` });

  // The one that actually bit us. A relative DATABASE_PATH resolves inside the
  // container's own filesystem, not the mounted volume — so every deploy
  // starts from an empty database and every saved setting is gone. The
  // Python-database guard does NOT catch this: a fresh file is a legitimately
  // empty database, and it passes.
  if (!path.isAbsolute(databasePath || '')) {
    out.push({
      level: 'warn',
      message: '[db] WARNING: DATABASE_PATH is not an absolute path, so the database is '
        + `on the container's own disk (${resolved}), NOT on a mounted volume. `
        + 'Every setting saved from the dashboard will be lost on the next deploy. '
        + `Set DATABASE_PATH to a path under ${volumeMountPath || 'the volume mount point'}.`,
    });
  } else if (volumeMountPath && !isInside(resolved, path.resolve(volumeMountPath))) {
    // The sharper version of the same bug, and the one the absolute-path check
    // above sails straight past. A volume is attached, but DATABASE_PATH points
    // somewhere else that merely *looks* durable — /data/bot.db when the mount
    // is /data/nodebot, say. Only the mount point itself survives a deploy;
    // every other absolute path is the container's ephemeral overlay disk.
    out.push({
      level: 'warn',
      message: `[db] WARNING: a volume is mounted at ${volumeMountPath}, but DATABASE_PATH `
        + `points to ${resolved}, which is OUTSIDE it — that is the container's own disk, `
        + 'not the volume. Every setting saved from the dashboard will be lost on the next '
        + `deploy. Set DATABASE_PATH to a path under ${volumeMountPath} `
        + `(e.g. ${path.posix.join(volumeMountPath, 'nodebot.db')}).`,
    });
  }

  // Not fatal, but it explains "everyone got logged out again": auth.js
  // generates a random signing key per process when this is unset, so every
  // restart invalidates every existing session cookie.
  if (!secretKey) {
    out.push({
      level: 'warn',
      message: '[web] WARNING: SECRET_KEY is not set, so session cookies are signed with a '
        + 'key generated fresh at startup. Everyone is logged out of the dashboard on '
        + 'every restart and every deploy. Set SECRET_KEY to any long random string.',
    });
  }

  return out;
}

/** Run the checks and print them. Returns the findings, for tests. */
export function reportPreflight(env) {
  const findings = preflightChecks(env);
  for (const { level, message } of findings) {
    if (level === 'warn') console.warn(message);
    else console.log(message);
  }
  return findings;
}
