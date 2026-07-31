import 'dotenv/config';

// Process start stamp — stamped into dashboard asset URLs to defeat browser
// caching, and shown as the dashboard build id.
export const BUILD_ID = String(Math.floor(Date.now() / 1000));

// Dashboard: password login and the key that signs session cookies. Same
// env var names as the Python bot.
export const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
export const SECRET_KEY = process.env.SECRET_KEY || '';
export const PORT = parseInt(process.env.PORT || '8000', 10);

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const CLIENT_ID = process.env.CLIENT_ID || '';
export const OWNER_ID = process.env.OWNER_ID || '';
export const DEV_GUILD_ID = process.env.DEV_GUILD_ID || '';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
// Model for background work — memory upkeep, signal classification,
// de-escalation assessments. That's the large majority of call volume and
// none of it needs the conversational model. "openrouter/free" routes
// across OpenRouter's free-model pool at $0.
export const OPENROUTER_UTILITY_MODEL = process.env.OPENROUTER_UTILITY_MODEL || 'openrouter/free';
// Spend breaker: hard cap on background model calls per hour (0 = uncapped).
export const OPENROUTER_BG_HOURLY_CAP = parseInt(process.env.OPENROUTER_BG_HOURLY_CAP || '240', 10);

// GitHub read access. The token is optional — without it the API still
// works anonymously at 60 requests/hour instead of 5000. GITHUB_REPO is the
// repo Max lives in, which is what the branch/PR/diff tools read.
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const GITHUB_REPO = process.env.GITHUB_REPO || 'seed0001/discord-agent';

// Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI Whisper, Groq, ...) — same env vars as the Python bot.
export const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY || '';
export const TRANSCRIPTION_API_URL = process.env.TRANSCRIPTION_API_URL || 'https://api.openai.com/v1';
export const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'whisper-1';

// TTS: Fish Audio when set, edge-tts (free, via msedge-tts) as fallback.
export const FISH_API_KEY = process.env.FISH_API_KEY || '';
export const FISH_TTS_MODEL = process.env.FISH_TTS_MODEL || 's2.1-pro-free';
export const FISH_VOICE_ID = process.env.FISH_VOICE_ID || '';

// Env-configured fallback defaults (used to seed db.js's DEFAULTS) — the
// live, per-guild values come from db.getSetting(guildId, 'voice_wake_words'
// / 'voice_cancel_words') once a guild has its own settings row. Same
// defaults as the Python bot's db.py DEFAULTS.
export const VOICE_WAKE_WORDS = (process.env.VOICE_WAKE_WORDS || 'hey max,hey andrew')
  .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
export const VOICE_CANCEL_WORDS = (process.env.VOICE_CANCEL_WORDS
  || 'never mind,nevermind,forget it,forget about it,cancel that,scratch that')
  .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

// Voice noise gate — utterances shorter than MIN_UTTERANCE_SEC seconds, or
// quieter than MIN_UTTERANCE_RMS (0-32768), are dropped as background-noise
// blips. Same env var names (and same defaults) the listener sidecar used,
// so tuning already set in the deployment carries over untouched.
export const MIN_UTTERANCE_SEC = parseFloat(process.env.MIN_UTTERANCE_SEC || '1.5');
export const MIN_UTTERANCE_RMS = parseInt(process.env.MIN_UTTERANCE_RMS || '300', 10);

// SQLite file path for the persistence layer (db.js).
export const DATABASE_PATH = process.env.DATABASE_PATH || 'nodebot.db';
