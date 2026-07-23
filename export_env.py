"""Print shell-ready env exports from persisted app config (for the voice listener)."""
import asyncio
import os
import sys

import app_config


async def main() -> int:
    data = await app_config.load_all_readonly()
    port = int(os.environ.get("PORT", "8001"))
    exports = {
        "DISCORD_TOKEN": data["discord_token"],
        "SECRET_KEY": data["secret_key"],
        "PORT": str(port),
        "PY_URL": f"http://127.0.0.1:{port}",
        "TRANSCRIPTION_API_KEY": data.get("transcription_api_key", ""),
        "TRANSCRIPTION_API_URL": data.get("transcription_api_url", ""),
        "TRANSCRIPTION_MODEL": data.get("transcription_model", ""),
        "OPENROUTER_API_KEY": data.get("openrouter_api_key", ""),
    }
    for key, value in exports.items():
        if value:
            print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
