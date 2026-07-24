"""First-run setup API — available without auth while onboarding is incomplete."""
import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

import app_config
import config
from web.auth import TOKEN_TTL, create_token

log = logging.getLogger("onboarding")
router = APIRouter(prefix="/setup", tags=["setup"])


class ValidateDiscordBody(BaseModel):
    discord_token: str


class CompleteSetupBody(BaseModel):
    discord_token: str
    owner_id: str
    openrouter_api_key: str = ""
    openrouter_model: str = "openai/gpt-4o-mini"
    github_token: str = ""
    transcription_api_key: str = ""
    transcription_api_url: str = "https://api.openai.com/v1"
    transcription_model: str = "whisper-1"
    dashboard_password: str = Field(min_length=8)
    secret_key: str = ""
    fish_api_key: str = ""
    fish_tts_model: str = "s1"
    fish_voice_id: str = ""


class UpdateAppConfigBody(BaseModel):
    discord_token: str = ""
    owner_id: str | None = None
    openrouter_api_key: str = ""
    openrouter_model: str | None = None
    github_token: str = ""
    transcription_api_key: str = ""
    transcription_api_url: str | None = None
    transcription_model: str | None = None
    dashboard_password: str = ""
    secret_key: str = ""
    fish_api_key: str = ""
    fish_tts_model: str | None = None
    fish_voice_id: str | None = None
    edge_tts_voice: str | None = None
    cursor_api_key: str = ""
    task_api_url: str | None = None
    task_api_key: str = ""


async def _require_setup_mode() -> None:
    if not await app_config.needs_setup():
        raise HTTPException(status_code=403, detail="Setup is already complete")


@router.get("/status")
async def setup_status():
    needs = await app_config.needs_setup()
    snapshot = await app_config.public_snapshot() if not needs else {}
    return {
        "needs_setup": needs,
        "config": snapshot,
        "env_locked": {
            key: app_config._env_value(key) is not None
            for key in ("discord_token", "dashboard_password", "secret_key", "owner_id")
        },
    }


@router.post("/validate-discord")
async def validate_discord(body: ValidateDiscordBody):
    await _require_setup_mode()
    return await app_config.validate_discord_token(body.discord_token)


@router.post("/complete")
async def complete_setup(body: CompleteSetupBody, request: Request, response: Response):
    await _require_setup_mode()

    discord_token = body.discord_token.strip() or str(await app_config.get_value("discord_token"))
    if not discord_token:
        raise HTTPException(status_code=400, detail="Discord bot token is required")

    owner_raw = body.owner_id.strip() or str(await app_config.get_value("owner_id") or "")
    try:
        owner_id = int(owner_raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Owner ID must be a numeric Discord user ID")
    if owner_id <= 0:
        raise HTTPException(status_code=400, detail="Owner ID is required")

    validation = await app_config.validate_discord_token(discord_token)
    if not validation.get("ok"):
        raise HTTPException(status_code=400, detail=validation.get("error", "Invalid token"))

    dashboard_password = body.dashboard_password or str(await app_config.get_value("dashboard_password"))
    if len(dashboard_password) < 8:
        raise HTTPException(status_code=400, detail="Dashboard password must be at least 8 characters")

    secret_key = body.secret_key.strip() or str(await app_config.get_value("secret_key") or "")
    secret_key = secret_key or app_config.generate_secret_key()

    await app_config.save_setup({
        "discord_token": discord_token,
        "owner_id": owner_id,
        "openrouter_api_key": body.openrouter_api_key.strip(),
        "openrouter_model": body.openrouter_model.strip() or app_config.DEFAULTS["openrouter_model"],
        "github_token": body.github_token.strip(),
        "transcription_api_key": body.transcription_api_key.strip(),
        "transcription_api_url": body.transcription_api_url.strip() or app_config.DEFAULTS["transcription_api_url"],
        "transcription_model": body.transcription_model.strip() or app_config.DEFAULTS["transcription_model"],
        "dashboard_password": dashboard_password,
        "secret_key": secret_key,
        "fish_api_key": body.fish_api_key.strip(),
        "fish_tts_model": body.fish_tts_model.strip() or app_config.DEFAULTS["fish_tts_model"],
        "fish_voice_id": body.fish_voice_id.strip(),
    })

    await config.reload()
    log.info("Onboarding complete — starting bot")

    starter = getattr(request.app.state, "start_bot", None)
    if starter:
        asyncio.create_task(starter())

    response.set_cookie(
        "session", create_token(),
        max_age=TOKEN_TTL, httponly=True, samesite="lax", secure=True,
    )
    return {"ok": True, "bot": validation}


async def update_app_config(body: UpdateAppConfigBody) -> dict:
    """Shared logic for updating app config from the dashboard."""
    data: dict = {}
    if body.discord_token.strip():
        validation = await app_config.validate_discord_token(body.discord_token)
        if not validation.get("ok"):
            raise HTTPException(status_code=400, detail=validation.get("error", "Invalid token"))
        data["discord_token"] = body.discord_token.strip()
    if body.owner_id is not None:
        try:
            owner_id = int(body.owner_id.strip())
        except ValueError:
            raise HTTPException(status_code=400, detail="Owner ID must be numeric")
        if owner_id <= 0:
            raise HTTPException(status_code=400, detail="Owner ID is required")
        data["owner_id"] = owner_id
    if body.openrouter_api_key.strip():
        data["openrouter_api_key"] = body.openrouter_api_key.strip()
    if body.openrouter_model is not None:
        data["openrouter_model"] = body.openrouter_model.strip()
    if body.github_token.strip():
        data["github_token"] = body.github_token.strip()
    if body.transcription_api_key.strip():
        data["transcription_api_key"] = body.transcription_api_key.strip()
    if body.transcription_api_url is not None:
        data["transcription_api_url"] = body.transcription_api_url.strip()
    if body.transcription_model is not None:
        data["transcription_model"] = body.transcription_model.strip()
    if body.dashboard_password:
        if len(body.dashboard_password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
        data["dashboard_password"] = body.dashboard_password
    if body.secret_key.strip():
        data["secret_key"] = body.secret_key.strip()
    if body.fish_api_key.strip():
        data["fish_api_key"] = body.fish_api_key.strip()
    if body.fish_tts_model is not None:
        data["fish_tts_model"] = body.fish_tts_model.strip()
    if body.fish_voice_id is not None:
        data["fish_voice_id"] = body.fish_voice_id.strip()
    if body.edge_tts_voice is not None:
        data["edge_tts_voice"] = body.edge_tts_voice.strip() or app_config.DEFAULTS["edge_tts_voice"]
    if body.cursor_api_key.strip():
        data["cursor_api_key"] = body.cursor_api_key.strip()
    if body.task_api_url is not None:
        data["task_api_url"] = body.task_api_url.strip()
    if body.task_api_key.strip():
        data["task_api_key"] = body.task_api_key.strip()

    if not data:
        raise HTTPException(status_code=400, detail="No changes provided")

    await app_config.update_config(data)
    await config.reload()
    return await app_config.public_snapshot()
