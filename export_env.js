#!/usr/bin/env node
// Print shell-ready KEY=VALUE lines from the Python bot's app_config table.
// Used by start.bat when secrets live in data/bot.db instead of .env.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const ENV_MAP = {
  discord_token: 'DISCORD_TOKEN',
  owner_id: 'OWNER_ID',
  openrouter_api_key: 'OPENROUTER_API_KEY',
  openrouter_model: 'OPENROUTER_MODEL',
  github_token: 'GITHUB_TOKEN',
  transcription_api_key: 'TRANSCRIPTION_API_KEY',
  transcription_api_url: 'TRANSCRIPTION_API_URL',
  transcription_model: 'TRANSCRIPTION_MODEL',
  dashboard_password: 'DASHBOARD_PASSWORD',
  secret_key: 'SECRET_KEY',
  fish_api_key: 'FISH_API_KEY',
  fish_tts_model: 'FISH_TTS_MODEL',
  fish_voice_id: 'FISH_VOICE_ID',
  edge_tts_voice: 'EDGE_TTS_VOICE',
};

const dbPath = process.argv[2] || 'data/bot.db';
if (!existsSync(dbPath)) process.exit(0);

const db = new DatabaseSync(dbPath, { readOnly: true });
let rows;
try {
  rows = db.prepare('SELECT key, value FROM app_config').all();
} catch {
  db.close();
  process.exit(0);
}
db.close();

const out = {};
for (const row of rows) {
  const envKey = ENV_MAP[row.key];
  if (!envKey) continue;
  let val;
  try {
    val = JSON.parse(row.value);
  } catch {
    val = row.value;
  }
  if (val === null || val === undefined || val === '') continue;
  out[envKey] = String(val);
}

// Application id for slash-command registration (not stored in old app_config).
if (out.DISCORD_TOKEN && !out.CLIENT_ID) {
  try {
    const res = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
      headers: { Authorization: `Bot ${out.DISCORD_TOKEN}` },
    });
    if (res.ok) {
      const app = await res.json();
      if (app?.id) out.CLIENT_ID = String(app.id);
    }
  } catch {
    // non-fatal — deploy-commands will skip
  }
}

for (const [key, value] of Object.entries(out)) {
  console.log(`${key}=${value}`);
}
