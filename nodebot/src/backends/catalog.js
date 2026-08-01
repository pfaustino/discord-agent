// OpenRouter's model list, refreshed on a timer and cached locally.
//
// The point is to know what she can switch TO when the current backend starts
// refusing. That answer changes — models appear, get deprecated, and change
// price — so it is fetched rather than hard-coded, and cached in SQLite so a
// restart or an OpenRouter outage doesn't leave her with no alternatives at
// the exact moment she needs one.
//
// The endpoint is public: no API key, and it is safe to call without spending
// anything. Only a distilled row per model is kept — the full response is
// ~400 models of prose and provider metadata, and the only things that matter
// for picking a fallback are what it costs, how much context it has, and
// whether it can do tool calling.
import { getDb } from '../db.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** How long a cached catalog stays usable before a refresh is attempted. */
export const REFRESH_INTERVAL_MS = 3600_000;
/** Past this, the catalog is too old to pick a fallback from confidently. It
 *  is still used — a stale list beats no list when the backend is down — but
 *  it is logged, because silently routing to a model that was deprecated a
 *  week ago is the kind of failure that wastes an afternoon. */
export const STALE_AFTER_MS = 24 * 3600_000;

const now = () => Math.floor(Date.now() / 1000);

/**
 * Distil one OpenRouter model entry to the fields a fallback decision needs.
 *
 * `pricing.prompt` / `pricing.completion` are per-token USD as decimal
 * strings. They are stored per MILLION tokens, which is the unit everything
 * else quotes and avoids carrying numbers like 0.0000008 around.
 */
export function distil(entry) {
  if (!entry?.id) return null;
  const params = entry.supported_parameters || [];
  const perMillion = (v) => {
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return null;
    // Rounded because binary floating point does not survive the scale-up:
    // 0.0000008 * 1e6 is 0.7999999999999999, and "$0.7999999999999999 per
    // million tokens" is not a thing to show anybody. Six places is far
    // finer than any real per-million price.
    return Math.round(n * 1e6 * 1e6) / 1e6;
  };
  return {
    id: String(entry.id),
    name: String(entry.name || entry.id),
    contextLength: Number.parseInt(entry.context_length, 10) || null,
    promptPrice: perMillion(entry.pricing?.prompt),
    completionPrice: perMillion(entry.pricing?.completion),
    // Tool calling is the one hard capability requirement for the
    // conversational model — she has ~30 tools and degrades badly without
    // them. Background work does not care.
    supportsTools: params.includes('tools'),
  };
}

/** Fetch and store the catalog. Returns the number of models stored.
 *
 * Never throws: a failed refresh leaves the previous catalog in place, which
 * is the right outcome. This runs on a timer with nobody watching. */
export async function refresh({ fetchImpl = fetch } = {}) {
  let entries;
  try {
    const resp = await fetchImpl(MODELS_URL, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    entries = body?.data;
    if (!Array.isArray(entries)) throw new Error('no data array in response');
  } catch (err) {
    console.warn('[backends] model catalog refresh failed:', err.message);
    return 0;
  }

  const rows = entries.map(distil).filter(Boolean);
  if (!rows.length) {
    console.warn('[backends] model catalog came back empty — keeping the old one');
    return 0;
  }

  const db = getDb();
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Replace wholesale rather than upsert: a model that vanished from
    // OpenRouter must vanish here too, or she will keep offering it.
    db.prepare('DELETE FROM model_catalog').run();
    const insert = db.prepare(`
      INSERT INTO model_catalog
        (id, name, context_length, prompt_price, completion_price, supports_tools, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(row.id, row.name, row.contextLength, row.promptPrice,
        row.completionPrice, row.supportsTools ? 1 : 0, stamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    console.warn('[backends] could not store model catalog:', err.message);
    return 0;
  }
  console.log(`[backends] model catalog refreshed — ${rows.length} models`);
  return rows.length;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contextLength: row.context_length,
    promptPrice: row.prompt_price,
    completionPrice: row.completion_price,
    supportsTools: Boolean(row.supports_tools),
    fetchedAt: row.fetched_at * 1000,
  };
}

export function get(modelId) {
  if (!modelId) return null;
  try {
    return hydrate(getDb().prepare('SELECT * FROM model_catalog WHERE id = ?').get(String(modelId)));
  } catch {
    return null; // database not up — treated as "unknown model", never fatal
  }
}

/** Every known model, optionally filtered to those that can call tools. */
export function list({ toolsOnly = false } = {}) {
  try {
    const sql = `SELECT * FROM model_catalog${toolsOnly ? ' WHERE supports_tools = 1' : ''}`;
    return getDb().prepare(sql).all().map(hydrate);
  } catch {
    return [];
  }
}

/** When the catalog was last successfully fetched, or null if never. */
export function fetchedAt() {
  try {
    const row = getDb().prepare('SELECT MAX(fetched_at) AS at FROM model_catalog').get();
    return row?.at ? row.at * 1000 : null;
  } catch {
    return null;
  }
}

export function isEmpty() {
  return fetchedAt() === null;
}

export function isStale(nowMs = Date.now()) {
  const at = fetchedAt();
  return at === null || nowMs - at > STALE_AFTER_MS;
}

/** True when a model costs nothing to call. Free models are the ones with
 *  hard daily request caps, which is why they need singling out. */
export function isFree(model) {
  return Boolean(model) && model.promptPrice === 0 && model.completionPrice === 0;
}

let timer = null;

/**
 * Start the hourly refresh. Fetches once immediately if the catalog is empty,
 * so a fresh install has alternatives available before the first rate limit
 * rather than an hour after it.
 */
export function startRefreshing({ intervalMs = REFRESH_INTERVAL_MS } = {}) {
  if (timer) return timer;
  if (isEmpty()) refresh();
  timer = setInterval(() => { refresh(); }, intervalMs);
  timer.unref?.(); // never hold the process open for a catalog refresh
  return timer;
}

export function stopRefreshing() {
  if (timer) clearInterval(timer);
  timer = null;
}
