import 'dotenv/config';

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const CLIENT_ID = process.env.CLIENT_ID || '';
export const OWNER_ID = process.env.OWNER_ID || '';
export const DEV_GUILD_ID = process.env.DEV_GUILD_ID || '';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';

// Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI Whisper, Groq, ...) — same env vars as the Python bot.
export const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY || '';
export const TRANSCRIPTION_API_URL = process.env.TRANSCRIPTION_API_URL || 'https://api.openai.com/v1';
export const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || 'whisper-1';

// TTS: Fish Audio when set, edge-tts (free, via msedge-tts) as fallback.
export const FISH_API_KEY = process.env.FISH_API_KEY || '';
export const FISH_TTS_MODEL = process.env.FISH_TTS_MODEL || 's2.1-pro-free';
export const FISH_VOICE_ID = process.env.FISH_VOICE_ID || '';

// No persistence layer yet (that's a later layer — see README), so wake/
// cancel words are env-configured for now instead of per-guild dashboard
// settings. Same defaults as the Python bot's db.py DEFAULTS.
export const VOICE_WAKE_WORDS = (process.env.VOICE_WAKE_WORDS || 'hey max,hey andrew')
  .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
export const VOICE_CANCEL_WORDS = (process.env.VOICE_CANCEL_WORDS
  || 'never mind,nevermind,forget it,forget about it,cancel that,scratch that')
  .split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
