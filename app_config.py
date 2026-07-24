"""Persisted application configuration with environment-variable overrides.

Env vars always win when set — this keeps Railway / Docker deploys working while
allowing first-run setup through the dashboard for local or self-hosted installs.
"""
from __future__ import annotations

import json
import os
import secrets
from typing import Any

import httpx

# Keys stored in SQLite (app_config table). Values are JSON-encoded.
CONFIG_KEYS = (
    "onboarding_complete",
    "discord_token",
    "owner_id",
    "openrouter_api_key",
    "openrouter_model",
    "github_token",
    "transcription_api_key",
    "transcription_api_url",
    "transcription_model",
    "dashboard_password",
    "secret_key",
    "fish_api_key",
    "fish_tts_model",
    "fish_voice_id",
    "edge_tts_voice",
    "cursor_api_key",
    "task_api_url",
    "task_api_key",
)

# Map config key -> env var name (when different)
_ENV_MAP = {
    "discord_token": "DISCORD_TOKEN",
    "owner_id": "OWNER_ID",
    "openrouter_api_key": "OPENROUTER_API_KEY",
    "openrouter_model": "OPENROUTER_MODEL",
    "github_token": "GITHUB_TOKEN",
    "transcription_api_key": "TRANSCRIPTION_API_KEY",
    "transcription_api_url": "TRANSCRIPTION_API_URL",
    "transcription_model": "TRANSCRIPTION_MODEL",
    "dashboard_password": "DASHBOARD_PASSWORD",
    "secret_key": "SECRET_KEY",
    "fish_api_key": "FISH_API_KEY",
    "fish_tts_model": "FISH_TTS_MODEL",
    "fish_voice_id": "FISH_VOICE_ID",
    "edge_tts_voice": "EDGE_TTS_VOICE",
    "cursor_api_key": "CURSOR_API_KEY",
    "task_api_url": "TASK_API_URL",
    "task_api_key": "TASK_API_KEY",
}

DEFAULTS: dict[str, Any] = {
    "onboarding_complete": False,
    "discord_token": "",
    "owner_id": 0,
    "openrouter_api_key": "",
    "openrouter_model": "openai/gpt-4o-mini",
    "github_token": "",
    "transcription_api_key": "",
    "transcription_api_url": "https://api.openai.com/v1",
    "transcription_model": "whisper-large-v3",
    "dashboard_password": "",
    "secret_key": "",
    "fish_api_key": "",
    "fish_tts_model": "s1",
    "fish_voice_id": "",
    "edge_tts_voice": "en-US-GuyNeural",
    "cursor_api_key": "",
    "task_api_url": "",
    "task_api_key": "",
}

SECRET_KEYS = frozenset({
    "discord_token",
    "openrouter_api_key",
    "github_token",
    "transcription_api_key",
    "dashboard_password",
    "secret_key",
    "fish_api_key",
    "cursor_api_key",
    "task_api_key",
})

REQUIRED_FOR_SETUP = ("discord_token", "owner_id", "dashboard_password", "secret_key")


def _env_value(key: str) -> Any | None:
    env_name = _ENV_MAP.get(key, key.upper())
    raw = os.environ.get(env_name)
    if raw is None or raw == "":
        return None
    if key == "owner_id":
        try:
            return int(raw)
        except ValueError:
            return 0
    if key == "onboarding_complete":
        return raw.lower() in ("1", "true", "yes")
    return raw


async def get_db_value(key: str) -> Any | None:
    import db
    return await db.get_app_config(key)


async def set_db_value(key: str, value: Any) -> None:
    import db
    await db.set_app_config(key, value)


async def _read_db_values_readonly() -> dict[str, Any]:
    """Read app_config without a write lock (safe while the bot is running)."""
    import aiosqlite

    import config as cfg

    path = os.path.abspath(cfg.DATABASE_PATH)
    if not os.path.isfile(path):
        return {}
    values: dict[str, Any] = {}
    async with aiosqlite.connect(f"file:{path}?mode=ro", uri=True) as conn:
        cur = await conn.execute("SELECT key, value FROM app_config")
        for key, raw in await cur.fetchall():
            values[key] = json.loads(raw)
    return values


def _apply_provider_fixes(data: dict[str, Any]) -> dict[str, Any]:
    url = str(data.get("transcription_api_url", ""))
    model = str(data.get("transcription_model", ""))
    if "groq.com" in url and model in ("whisper-1", "whisper"):
        data["transcription_model"] = "whisper-large-v3"
    elif "openai.com" in url and model in ("whisper-large-v3", "whisper-large-v3-turbo"):
        data["transcription_model"] = "whisper-1"
    return data


async def _merge_config(db_values: dict[str, Any] | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key in CONFIG_KEYS:
        env = _env_value(key)
        if env is not None:
            data[key] = env
        elif db_values is not None:
            stored = db_values.get(key)
            data[key] = stored if stored is not None else DEFAULTS[key]
        else:
            stored = await get_db_value(key)
            data[key] = stored if stored is not None else DEFAULTS[key]
    return _apply_provider_fixes(data)


async def _load() -> dict[str, Any]:
    """Load config with env overrides, then apply provider-specific fixes."""
    return await _merge_config()


async def load_all_readonly() -> dict[str, Any]:
    """Load config via a read-only DB connection (for export_env / start scripts)."""
    return await _merge_config(await _read_db_values_readonly())


async def get_value(key: str) -> Any:
    return (await _load())[key]


async def load_all() -> dict[str, Any]:
    return dict(await _load())


def mask_secret(value: str, visible: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= visible:
        return "•" * len(value)
    return "•" * (len(value) - visible) + value[-visible:]


async def public_snapshot() -> dict[str, Any]:
    """Non-secret config for the dashboard (secrets show masked placeholders)."""
    data = await load_all()
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in SECRET_KEYS:
            out[key] = mask_secret(str(value)) if value else ""
            out[f"{key}_set"] = bool(value)
        else:
            out[key] = value
    return out


async def needs_setup() -> bool:
    """True when the dashboard should show the first-run wizard."""
    if _env_value("discord_token") and _env_value("dashboard_password"):
        return False
    complete = await get_value("onboarding_complete")
    if complete:
        return False
    token = await get_value("discord_token")
    password = await get_value("dashboard_password")
    return not (token and password)


async def save_setup(data: dict[str, Any]) -> None:
    """Persist onboarding form data and mark setup complete."""
    for key in CONFIG_KEYS:
        if key == "onboarding_complete":
            continue
        if key in data:
            await set_db_value(key, data[key])
    await set_db_value("onboarding_complete", True)


async def update_config(data: dict[str, Any]) -> None:
    """Update individual config keys from the dashboard (empty secrets = keep existing)."""
    for key, value in data.items():
        if key not in CONFIG_KEYS or key == "onboarding_complete":
            continue
        if key in SECRET_KEYS and value == "":
            continue
        await set_db_value(key, value)


async def validate_discord_token(token: str) -> dict:
    token = token.strip()
    if not token:
        return {"ok": False, "error": "Token is required"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://discord.com/api/v10/users/@me",
                headers={"Authorization": f"Bot {token}"},
            )
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"Could not reach Discord: {exc}"}
    if r.status_code != 200:
        return {"ok": False, "error": "Invalid bot token — check the Developer Portal"}
    bot = r.json()
    return {
        "ok": True,
        "id": bot["id"],
        "username": bot["username"],
        "avatar": bot.get("avatar"),
    }


def generate_secret_key() -> str:
    return secrets.token_hex(32)
