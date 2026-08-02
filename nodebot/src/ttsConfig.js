// Per-guild TTS preferences — voice id, model, Edge fallback voice.
// null in the database means "use the deployment env default" (Railway).
import * as db from './db.js';
import {
  FISH_VOICE_ID, FISH_TTS_MODEL, EDGE_TTS_VOICE,
} from './config.js';

function pickOverride(guildId, key) {
  if (guildId == null || guildId === undefined) return null;
  try {
    const value = db.getSetting(guildId, key);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/** Fish voice ids are hex strings; admins often paste the full fish.audio URL. */
export function normalizeFishVoiceId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const fromPath = text.match(/\/m\/([0-9a-f]{32})/i);
  if (fromPath) return fromPath[1].toLowerCase();
  return text.replace(/^https?:\/\/[^/]+\//i, '').trim();
}

/** Resolved TTS config for one guild (dashboard override or env default). */
export function ttsConfigForGuild(guildId) {
  const envVoice = normalizeFishVoiceId(FISH_VOICE_ID);
  const overrideVoice = pickOverride(guildId, 'fish_voice_id');
  return {
    fishVoiceId: normalizeFishVoiceId(overrideVoice || envVoice),
    fishModel: pickOverride(guildId, 'fish_tts_model') || FISH_TTS_MODEL,
    edgeVoice: pickOverride(guildId, 'edge_tts_voice') || EDGE_TTS_VOICE,
  };
}

/** Read-only companions for the settings GET — where each value came from. */
export function ttsSettingsMeta(guildId) {
  const overrideVoice = pickOverride(guildId, 'fish_voice_id');
  const overrideModel = pickOverride(guildId, 'fish_tts_model');
  const overrideEdge = pickOverride(guildId, 'edge_tts_voice');
  const resolved = ttsConfigForGuild(guildId);
  return {
    fish_voice_id_effective: resolved.fishVoiceId || null,
    fish_tts_model_effective: resolved.fishModel,
    edge_tts_voice_effective: resolved.edgeVoice,
    fish_voice_id_source: overrideVoice ? 'override' : 'env',
    fish_tts_model_source: overrideModel ? 'override' : 'env',
    edge_tts_voice_source: overrideEdge ? 'override' : 'env',
  };
}
