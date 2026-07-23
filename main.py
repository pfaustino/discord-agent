"""Entry point: runs the Discord bot and the dashboard web server in one process."""
import asyncio
import logging

import uvicorn

import config
import db
from bot.client import bot
from web.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("main")


async def main():
    await db.init_db()
    await config.reload()

    if not config.DISCORD_TOKEN:
        log.info("No Discord token yet — dashboard will run in setup mode")
    if not config.OWNER_ID:
        log.warning("OWNER_ID is not set — owner-only management commands will deny everyone.")
    if not config.DASHBOARD_PASSWORD:
        log.warning("DASHBOARD_PASSWORD is not set — complete setup at the dashboard.")
    if not config.SECRET_KEY:
        log.warning("SECRET_KEY is not set — sessions will reset on restart until setup completes.")

    app = create_app(bot)
    server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=config.PORT, log_level="info"))

    bot_task: asyncio.Task | None = None

    async def start_bot() -> None:
        nonlocal bot_task
        await config.reload()
        if not config.DISCORD_TOKEN:
            log.warning("Cannot start bot — DISCORD_TOKEN is missing")
            return
        if bot.is_ready():
            log.info("Bot is already connected")
            return
        if bot_task and not bot_task.done():
            log.info("Bot is already starting")
            return

        async def _run():
            try:
                await bot.start(config.DISCORD_TOKEN)
            except Exception:
                log.exception("Bot crashed")

        bot_task = asyncio.create_task(_run(), name="discord-bot")
        log.info("Discord bot starting…")

    app.state.start_bot = start_bot

    web_task = asyncio.create_task(server.serve(), name="web-server")

    if config.DISCORD_TOKEN:
        await start_bot()

    done, pending = await asyncio.wait(
        [t for t in (bot_task, web_task) if t is not None],
        return_when=asyncio.FIRST_COMPLETED,
    )
    for task in pending:
        task.cancel()
    for task in done:
        task.result()

    await db.close_db()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
