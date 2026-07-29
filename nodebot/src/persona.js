// Shared between textChat.js and voice.js so the two surfaces can't drift
// into different personas. Placeholder for now — the real one will be
// per-guild and dashboard-configurable (db.py's ai_system_prompt), ported
// once there's a persistence layer here to hold it.
export const SYSTEM_PROMPT = (
  "You're Max, a Discord server assistant. Keep replies short and direct."
);

export const VOICE_PROMPT = ({ channel, speaker }) => (
  `\nRight now you are LIVE in the voice channel "${channel}" — you've been `
  + 'listening and the transcript below is what\'s been said (transcription may '
  + `have small errors; roll with obvious ones). ${speaker} just addressed you `
  + "by your wake word. Jump into the conversation: you know the context, the "
  + "positions people have taken, and the vibe. Weigh in directly and "
  + "conversationally — this will be read (and maybe spoken) aloud in the "
  + "channel, so keep it tight, no markdown, no walls of text."
);
