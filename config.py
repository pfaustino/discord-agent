"""Runtime configuration — env vars override values saved during onboarding."""
from __future__ import annotations

import os

# Non-persisted infrastructure settings (env only)
SIDECAR_URL = os.environ.get("SIDECAR_URL", "http://127.0.0.1:8091")
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/bot.db")
PORT = int(os.environ.get("PORT", "8000"))

# Persisted settings — updated by reload() after DB init / onboarding
DISCORD_TOKEN = ""
OWNER_ID = 0
OPENROUTER_API_KEY = ""
OPENROUTER_MODEL = "openai/gpt-4o-mini"
GITHUB_TOKEN = ""
TRANSCRIPTION_API_KEY = ""
TRANSCRIPTION_API_URL = "https://api.openai.com/v1"
TRANSCRIPTION_MODEL = "whisper-large-v3"
FISH_API_KEY = ""
FISH_TTS_MODEL = "s1"
FISH_VOICE_ID = ""
EDGE_TTS_VOICE = "en-US-GuyNeural"
DASHBOARD_PASSWORD = ""
SECRET_KEY = ""
ONBOARDING_COMPLETE = False


async def reload() -> None:
    """Load persisted config from SQLite (env overrides still apply)."""
    global DISCORD_TOKEN, OWNER_ID, OPENROUTER_API_KEY, OPENROUTER_MODEL
    global GITHUB_TOKEN, TRANSCRIPTION_API_KEY, TRANSCRIPTION_API_URL, TRANSCRIPTION_MODEL
    global FISH_API_KEY, FISH_TTS_MODEL, FISH_VOICE_ID, EDGE_TTS_VOICE
    global DASHBOARD_PASSWORD, SECRET_KEY, ONBOARDING_COMPLETE

    import app_config

    data = await app_config.load_all()
    DISCORD_TOKEN = data["discord_token"]
    OWNER_ID = int(data["owner_id"] or 0)
    OPENROUTER_API_KEY = data["openrouter_api_key"]
    OPENROUTER_MODEL = data["openrouter_model"]
    GITHUB_TOKEN = data["github_token"]
    TRANSCRIPTION_API_KEY = data["transcription_api_key"]
    TRANSCRIPTION_API_URL = data["transcription_api_url"]
    TRANSCRIPTION_MODEL = data["transcription_model"]
    FISH_API_KEY = data["fish_api_key"]
    FISH_TTS_MODEL = data["fish_tts_model"]
    FISH_VOICE_ID = data["fish_voice_id"]
    EDGE_TTS_VOICE = data["edge_tts_voice"]
    DASHBOARD_PASSWORD = data["dashboard_password"]
    SECRET_KEY = data["secret_key"]
    ONBOARDING_COMPLETE = bool(data["onboarding_complete"])
