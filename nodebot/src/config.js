import 'dotenv/config';

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const CLIENT_ID = process.env.CLIENT_ID || '';
export const OWNER_ID = process.env.OWNER_ID || '';
export const DEV_GUILD_ID = process.env.DEV_GUILD_ID || '';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku';
