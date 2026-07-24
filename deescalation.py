"""De-escalation gate: context-validated, deterministic, restart-safe.

The pressure system (or any safety signal) only NOMINATES a moment. An LLM
assessment of the recent conversation is reduced to the structured
`Assessment` below, and this module's deterministic gate decides whether
Max opens his mouth — and never with more than the restrained ladder:

    stage 0: one brief neutral check-in
    stage 1: suggest pausing / moving a personal dispute to DMs
    stage 2: notify moderators (no punishment — ever)

Profanity, loudness, disagreement, teasing, roleplay, and passionate
debate are explicitly NOT escalation. Serious signals are repeated
targeted insults, credible threats, escalating personal hostility,
sustained disruptive cross-talk, and ignored requests to stop. A server
preference for limiting harsh language can enable gentle check-ins, but
that track is separate from safety and can never climb the ladder.

Pure logic, no I/O: callers persist `ConflictState` and pass timestamps,
so behavior is deterministic and testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

MIN_STEP_S = 90.0        # minimum seconds between ladder actions
HARSH_COOLDOWN_S = 900.0  # between harsh-language check-ins
SETTLE_S = 300.0         # quiet/falling this long → conflict is over
CONFIRMATIONS_TO_ESCALATE = 1  # serious assessments needed beyond current stage

STAGE_IDLE = -1
STAGE_CHECKED_IN = 0
STAGE_SUGGESTED_PAUSE = 1
STAGE_MODS_NOTIFIED = 2


@dataclass
class Assessment:
    """Structured read of the recent conversation (LLM output, validated)."""
    ts: float
    tension: str = "steady"        # rising | steady | falling
    participants: int = 2
    targeted_insults: int = 0      # insults aimed at a person, this window
    insult_repeat: bool = False    # same person targeted repeatedly
    credible_threat: bool = False
    stop_ignored: bool = False     # someone asked to stop; it continued
    cross_talk: bool = False       # sustained disruptive talking-over
    banter: bool = False           # joking / teasing / roleplay / debate vibes
    harsh_language: bool = False   # profanity/harshness without targeting
    summary: str = ""

    def serious(self, prior_confirmations: int) -> list[str]:
        """Reasons this assessment counts as genuinely serious (not vibes)."""
        reasons = []
        if self.credible_threat:
            reasons.append("credible threat")
        if self.targeted_insults >= 2:
            reasons.append(f"repeated targeted insults ({self.targeted_insults})")
        if self.insult_repeat and self.tension == "rising":
            reasons.append("escalating personal hostility")
        if self.stop_ignored:
            reasons.append("request to stop was ignored")
        if self.cross_talk and prior_confirmations >= 1:
            reasons.append("sustained disruptive cross-talk")
        return reasons


@dataclass
class ConflictState:
    stage: int = STAGE_IDLE
    opened_ts: float = 0.0
    last_action_ts: float = 0.0
    last_serious_ts: float = 0.0
    confirmations: int = 0
    harsh_streak: int = 0
    last_harsh_action_ts: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict | None) -> "ConflictState":
        state = cls()
        for k, v in (data or {}).items():
            if hasattr(state, k):
                setattr(state, k, v)
        return state


@dataclass
class GateDecision:
    action: str                    # none | check_in | suggest_pause | notify_mods
    reasons: list[str] = field(default_factory=list)
    state: ConflictState = field(default_factory=ConflictState)
    settled: bool = False


ACTIONS = {
    STAGE_CHECKED_IN: "check_in",
    STAGE_SUGGESTED_PAUSE: "suggest_pause",
    STAGE_MODS_NOTIFIED: "notify_mods",
}


def decide(state: ConflictState, a: Assessment,
           harsh_language_pref: bool = False) -> GateDecision:
    """The deterministic gate. Returns the action (if any), why, and the
    updated state for the caller to persist."""
    now = a.ts
    serious_reasons = a.serious(state.confirmations)

    # -- settling / disengagement -------------------------------------------
    if not serious_reasons:
        # any non-idle stage implies a serious moment happened; measure from it
        quiet_for = (now - state.last_serious_ts) if state.stage != STAGE_IDLE else 0.0
        if state.stage != STAGE_IDLE and (
                a.tension == "falling" or quiet_for >= SETTLE_S):
            fresh = ConflictState(last_harsh_action_ts=state.last_harsh_action_ts)
            return GateDecision(
                action="none", settled=True, state=fresh,
                reasons=["conflict settled — disengaging and resetting the ladder"])

    # -- banter / non-escalation --------------------------------------------
    if a.banter and not a.credible_threat:
        state.harsh_streak = 0
        return GateDecision(action="none", state=state, reasons=[
            "reads as banter/teasing/roleplay/debate — not escalation"])

    # -- harsh language track (server preference; never climbs the ladder) --
    if not serious_reasons:
        if a.harsh_language and harsh_language_pref and state.stage == STAGE_IDLE:
            state.harsh_streak += 1
            harsh_cooldown_clear = (state.last_harsh_action_ts == 0.0
                                    or now - state.last_harsh_action_ts >= HARSH_COOLDOWN_S)
            if state.harsh_streak >= 2 and harsh_cooldown_clear:
                state.harsh_streak = 0
                state.last_harsh_action_ts = now
                return GateDecision(action="check_in", state=state, reasons=[
                    "sustained harsh language and this server prefers it dialed "
                    "back (preference track — cannot escalate past a check-in)"])
            return GateDecision(action="none", state=state, reasons=[
                f"harsh language noted ({state.harsh_streak}x) — below the "
                "preference threshold"])
        return GateDecision(action="none", state=state, reasons=[
            "no serious signals: profanity/volume/disagreement alone are not "
            "escalation"])

    # -- serious path --------------------------------------------------------
    state.last_serious_ts = now
    state.confirmations += 1
    if state.stage == STAGE_IDLE:
        state.opened_ts = now

    if state.stage >= STAGE_MODS_NOTIFIED:
        return GateDecision(action="none", state=state, reasons=serious_reasons + [
            "moderators already notified — humans own it from here"])

    # credible threats fast-track straight to the moderators
    next_stage = STAGE_MODS_NOTIFIED if a.credible_threat else state.stage + 1

    # a non-idle stage means an action was taken at last_action_ts (0.0 is a
    # valid timestamp in tests — never treat it as "no action")
    if state.stage != STAGE_IDLE and now - state.last_action_ts < MIN_STEP_S \
            and not a.credible_threat:
        return GateDecision(action="none", state=state, reasons=serious_reasons + [
            f"holding — last intervention was {now - state.last_action_ts:.0f}s "
            f"ago (min {MIN_STEP_S:.0f}s between steps)"])

    if not a.credible_threat and state.confirmations < state.stage + 1 + CONFIRMATIONS_TO_ESCALATE:
        return GateDecision(action="none", state=state, reasons=serious_reasons + [
            "needs another confirming read before escalating further"])

    state.stage = next_stage
    state.last_action_ts = now
    return GateDecision(action=ACTIONS[next_stage], state=state,
                        reasons=serious_reasons + [f"ladder step -> {ACTIONS[next_stage]}"])
