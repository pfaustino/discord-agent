"""De-escalation integration: pressure nominates, validated context decides.

Nomination comes from the proactive classifier's safety_concern signals
(text and voice both flow through it). On nomination — and periodically
while a conflict is open — the recent conversation is assessed by the
model into the structured Assessment, and the deterministic gate in
deescalation.py decides: stay quiet, one neutral check-in, suggest a
pause/DMs, or notify moderators. Max never punishes through this system;
timeouts/kicks/bans remain human or explicit-automod decisions.

Ladder state persists per channel in guild settings (restart-safe). Every
decision — spoken or silent — is logged with its reasons.
"""
import asyncio
import json
import logging
import time

import discord
from discord.ext import commands

import db
import openrouter
from deescalation import Assessment, ConflictState, decide

log = logging.getLogger("deescalate")

ASSESS_MIN_INTERVAL = 25.0   # seconds between assessments per channel
TRANSCRIPT_LINES = 15

ASSESS_PROMPT = (
    "You are reading the temperature of a Discord conversation for a "
    "de-escalation system. Judge CONTEXT, not keywords: profanity, loudness, "
    "disagreement, teasing, roleplay, and passionate debate are NOT "
    "escalation by themselves. Serious signals are: insults repeatedly "
    "aimed at a specific person, credible threats, personal hostility that "
    "is escalating, sustained disruptive talking-over, or someone's request "
    "to stop being ignored. Consider who is addressing whom, how many "
    "people are involved, repetition, and whether tension is actually "
    "increasing.\n\nConversation (most recent last):\n{transcript}\n\n"
    'Reply ONLY with JSON: {{"tension": "rising|steady|falling", '
    '"participants": N, "targeted_insults": N, "insult_repeat": bool, '
    '"credible_threat": bool, "stop_ignored": bool, "cross_talk": bool, '
    '"banter": bool, "harsh_language": bool, "summary": "one line"}}'
)

CHECK_IN_TEXT = (
    "yo, quick vibe check — things are getting a little heated in here. "
    "we all good?"
)
SUGGEST_PAUSE_TEXT = (
    "hey, real talk: this one's getting personal. might be worth taking "
    "five, or moving it to DMs. no refs needed, just looking out."
)


def _parse_assessment(reply: str, now: float) -> Assessment | None:
    try:
        start, end = reply.index("{"), reply.rindex("}") + 1
        data = json.loads(reply[start:end])
    except (ValueError, json.JSONDecodeError):
        return None
    tension = str(data.get("tension", "steady")).lower()
    return Assessment(
        ts=now,
        tension=tension if tension in ("rising", "steady", "falling") else "steady",
        participants=max(1, int(data.get("participants", 2) or 2)),
        targeted_insults=max(0, int(data.get("targeted_insults", 0) or 0)),
        insult_repeat=bool(data.get("insult_repeat")),
        credible_threat=bool(data.get("credible_threat")),
        stop_ignored=bool(data.get("stop_ignored")),
        cross_talk=bool(data.get("cross_talk")),
        banter=bool(data.get("banter")),
        harsh_language=bool(data.get("harsh_language")),
        summary=str(data.get("summary", ""))[:200],
    )


class Deescalate(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.last_assess: dict[int, float] = {}
        self.open_channels: set[int] = set()  # rebuilt lazily; DB is the truth
        self.locks: dict[int, asyncio.Lock] = {}

    def _lock(self, channel_id: int) -> asyncio.Lock:
        return self.locks.setdefault(channel_id, asyncio.Lock())

    async def _state(self, guild_id: int, channel_id: int) -> ConflictState:
        return ConflictState.from_dict(await db.get_setting(guild_id, f"deesc:{channel_id}"))

    async def _save(self, guild_id: int, channel_id: int, state: ConflictState):
        await db.set_setting(guild_id, f"deesc:{channel_id}", state.to_dict())

    def _transcript(self, channel_id: int) -> str:
        voice_cog = self.bot.get_cog("Voice")
        if voice_cog is not None and voice_cog.transcripts.get(channel_id):
            lines = [f"{e['name']}: {e['text']}"
                     for e in voice_cog.transcripts[channel_id]
                     if not e.get("system")][-TRANSCRIPT_LINES:]
            return "\n".join(lines)
        proactive = self.bot.get_cog("Proactive")
        if proactive is not None:
            return "\n".join(list(proactive.context[channel_id])[-TRANSCRIPT_LINES:])
        return ""

    # -- entry points --------------------------------------------------------

    async def nominate(self, guild: discord.Guild, channel_id: int):
        """A safety signal nominated this moment. Context decides the rest."""
        await self._run(guild, channel_id, source="nomination")

    async def observe(self, guild: discord.Guild, channel_id: int):
        """Ongoing traffic in a channel with an open conflict — reassess."""
        if channel_id in self.open_channels:
            await self._run(guild, channel_id, source="observation")

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or message.author.bot:
            return
        await self.observe(message.guild, message.channel.id)

    # -- the loop: assess -> gate -> act ------------------------------------

    async def _run(self, guild: discord.Guild, channel_id: int, source: str):
        if not await db.get_setting(guild.id, "deesc_enabled"):
            return
        if await db.get_setting(guild.id, "quiet_mode"):
            return
        now = time.time()
        if now - self.last_assess.get(channel_id, 0) < ASSESS_MIN_INTERVAL:
            return
        self.last_assess[channel_id] = now

        async with self._lock(channel_id):
            transcript = self._transcript(channel_id)
            if not transcript:
                return
            assessment = await self._assess(guild, transcript, now)
            if assessment is None:
                return
            state = await self._state(guild.id, channel_id)
            harsh_pref = bool(await db.get_setting(guild.id, "deesc_harsh_language"))
            decision = decide(state, assessment, harsh_language_pref=harsh_pref)
            await self._save(guild.id, channel_id, decision.state)

            if decision.state.stage >= 0 and not decision.settled:
                self.open_channels.add(channel_id)
            else:
                self.open_channels.discard(channel_id)

            log.info("[deesc:%s ch=%s] action=%s | %s | %s",
                     source, channel_id, decision.action,
                     "; ".join(decision.reasons), assessment.summary)
            if decision.action != "none":
                await self._act(guild, channel_id, decision, assessment)

    async def _assess(self, guild, transcript: str, now: float) -> Assessment | None:
        try:
            reply = await openrouter.chat(
                [{"role": "user", "content": ASSESS_PROMPT.format(transcript=transcript)}],
                model=await db.get_setting(guild.id, "ai_model"),
                temperature=0.0, max_tokens=250,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("assessment failed: %s", exc)
            return None
        return _parse_assessment(reply, now)

    # -- actions (never punitive) --------------------------------------------

    async def _act(self, guild, channel_id: int, decision, assessment: Assessment):
        from bot.utils import log_action

        channel = guild.get_channel(channel_id)
        if channel is None:
            return
        if decision.action == "notify_mods":
            await log_action(
                guild, "deescalation", "Max (de-escalation)",
                f"#{channel.name}",
                f"stage {decision.state.stage} reached — {assessment.summary} "
                f"[{'; '.join(decision.reasons)[:300]}]")
            log.warning("moderators notified for #%s: %s", channel.name, assessment.summary)
            return
        text = CHECK_IN_TEXT if decision.action == "check_in" else SUGGEST_PAUSE_TEXT
        try:
            await channel.send(text)
        except discord.HTTPException:
            return
        if isinstance(channel, discord.VoiceChannel):
            voice_cog = self.bot.get_cog("Voice")
            if voice_cog is not None:
                try:
                    await voice_cog.speak_in_voice(guild, channel_id, text)
                except Exception:
                    log.exception("de-escalation TTS failed")


async def setup(bot: commands.Bot):
    await bot.add_cog(Deescalate(bot))
