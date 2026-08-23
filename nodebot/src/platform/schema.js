// Platform tables: who the customer is, what bots they have, what they
// ordered, and the credit ledger those bots draw on.
//
// Exported as a plain string with no imports, so db.js can exec it alongside
// its own schema without either module importing the other.
//
// ── How credit reaches a bot ────────────────────────────────────────────────
//
//   accounts  ──1:N──▶  platform_servers  ──1:1──▶  a Discord guild
//      │
//      └── credits_milli   ONE pooled balance, shared by every server
//
// A bot bills by looking up its own guild id in `platform_servers`, following
// that to the account, and drawing on the pooled balance. Two consequences
// worth being deliberate about:
//
//   * A guild with no row here is not a managed bot. It is never metered and
//     never gated — which is exactly what a self-hosted install and an
//     enterprise (bring-your-own-keys) customer should get, with no flag to
//     remember to set.
//   * The balance is pooled, not allocated per server. A customer never has
//     one bot go silent while another sits on unused credit. Per-server spend
//     is still recoverable — every usage event records its server_id — so the
//     reporting works without the rationing.
//
// `guild_id` is UNIQUE: two servers cannot claim the same guild, so "which
// account does this bot bill?" always has exactly one answer.

export const PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    venue         TEXT NOT NULL DEFAULT 'managed',
    credits_milli INTEGER NOT NULL DEFAULT 0,
    auto_topup    TEXT NOT NULL DEFAULT '{}',
    is_staff      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_servers (
    id             TEXT PRIMARY KEY,
    account_id     TEXT NOT NULL,
    request_id     TEXT,
    guild_id       TEXT UNIQUE,
    name           TEXT NOT NULL,
    bot_name       TEXT,
    tier           TEXT,
    modules        TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'provisioning',
    provisioned_at INTEGER,
    created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_requests (
    id           TEXT PRIMARY KEY,
    account_id   TEXT,
    venue        TEXT NOT NULL DEFAULT 'managed',
    account_name TEXT,
    email        TEXT,
    server_name  TEXT,
    bot_name     TEXT,
    tier         TEXT,
    modules      TEXT NOT NULL DEFAULT '[]',
    details      TEXT NOT NULL DEFAULT '{}',
    stage        TEXT NOT NULL DEFAULT 'submitted',
    notes        TEXT NOT NULL DEFAULT '',
    submitted_at INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL,
    server_id     TEXT,
    guild_id      TEXT,
    kind          TEXT NOT NULL,
    quantity      REAL NOT NULL,
    credits_milli INTEGER NOT NULL,
    charged_milli INTEGER NOT NULL,
    provider_ref  TEXT,
    meta          TEXT,
    at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_grants (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL,
    credits_milli INTEGER NOT NULL,
    pack_id       TEXT,
    amount_cents  INTEGER,
    source        TEXT NOT NULL DEFAULT 'manual',
    reference     TEXT,
    issued_by     TEXT,
    note          TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_servers_account ON platform_servers (account_id);
-- Approving from the staff queue must be idempotent: a double-click cannot
-- end up provisioning the same order twice. Partial, because a server added
-- by hand has no order behind it and several of those may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_request
    ON platform_servers (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_requests_stage ON platform_requests (stage, submitted_at);
CREATE INDEX IF NOT EXISTS idx_usage_account_at ON usage_events (account_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_server_at ON usage_events (server_id, at);
CREATE INDEX IF NOT EXISTS idx_grants_account ON credit_grants (account_id, created_at);
`;
