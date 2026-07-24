"""Structured data models for the pressure engine.

Everything the engine knows lives in these explicit structures (persisted by
store.py) — never in model weights or hidden LLM memory.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict

# Terminal signal states — a signal in one of these never charges again
RESOLVED_STATES = {
    "spoken",        # we addressed it ourselves
    "satisfied",     # someone else solved it
    "declined",      # the user said no thanks
    "abandoned",     # goal dropped / topic left long enough
    "expired",       # max lifetime reached
    "low_confidence",  # confidence fell below the floor
    "superseded",    # replaced by a newer signal with the same key
}


@dataclass
class Signal:
    """One weighted piece of evidence that Max might have something to say."""
    key: str                 # idempotency key — same key never charges twice
    source: str              # e.g. "unresolved_blocker", "incorrect_claim"
    weight: float            # 0..1 base importance of this source instance
    confidence: float        # 0..1 how sure the classifier was
    ts: float                # unix time the signal was observed
    topic: str               # topic/entity association ("deploy", "tabs-vs-spaces")
    channel_id: str = ""
    user_id: str = ""        # who the signal is about/for (cooldown scoping)
    evidence: str = ""       # why this signal exists, for the audit trail
    decay: str = "exp"       # "exp" | "linear" | "none"
    decay_rate: float = 1 / 600  # per-second (exp: fraction; linear: units)
    max_lifetime: float = 1800.0  # seconds until forced expiry
    state: str = "active"
    resolved_reason: str = ""
    resolved_ts: float | None = None

    def strength(self, now: float) -> float:
        """Current effective strength, honoring decay and expiry."""
        if self.state != "active":
            return 0.0
        age = max(0.0, now - self.ts)
        if age >= self.max_lifetime:
            return 0.0
        base = self.weight * self.confidence
        if self.decay == "exp":
            return base * math.exp(-self.decay_rate * age)
        if self.decay == "linear":
            return max(0.0, base - self.decay_rate * age)
        return base

    def resolve(self, reason: str, now: float) -> None:
        if self.state == "active":
            self.state = reason if reason in RESOLVED_STATES else "satisfied"
            self.resolved_reason = reason
            self.resolved_ts = now

    def to_row(self) -> dict:
        return asdict(self)


@dataclass
class Proposal:
    """A candidate proactive contribution, evaluated by the gate."""
    topic: str
    bucket: str
    content_key: str          # normalized identity of the point being made
    summary: str              # what would be said (or a summary of it)
    provides_new_info: bool = True
    question_count: int = 0
    relevance: float = 1.0    # 0..1 from the relevance evaluator
    channel_id: str = ""
    user_id: str = ""
    urgent: bool = False      # safety/moderation may bypass interruption hold


@dataclass
class Decision:
    """The gate's verdict on one proposal — always logged, pass or fail."""
    ts: float
    allowed: bool
    reasons: list[str] = field(default_factory=list)
    proposal_topic: str = ""
    proposal_bucket: str = ""
    proposal_summary: str = ""
    channel_id: str = ""
    pressures: dict = field(default_factory=dict)

    def to_row(self) -> dict:
        d = asdict(self)
        d["reasons"] = json.dumps(d["reasons"])
        d["pressures"] = json.dumps(d["pressures"])
        return d


@dataclass
class Contribution:
    """A proactive message that actually went out (repetition history)."""
    ts: float
    topic: str
    bucket: str
    content_key: str
    summary: str
    channel_id: str = ""
