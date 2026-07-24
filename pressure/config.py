"""Engine configuration: buckets, signal routing, gate, cooldowns, metabolism.

Everything tunable lives here so behavior is inspectable and testable.
Weights/thresholds are starting points, not gospel.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BucketConfig:
    threshold: float          # pressure needed before the gate can open
    gain: float = 1.0         # multiplier applied to incoming signal charge
    decay_rate: float = 1 / 900   # per-second exponential pressure decay
    cap: float = 3.0          # hard ceiling — pressure can never grow forever
    release_fraction: float = 0.85  # discharged when a contribution is made


@dataclass
class EngineConfig:
    # Conversational buckets (adapted from digital-pressure's drive buckets)
    buckets: dict[str, BucketConfig] = field(default_factory=lambda: {
        "assist":    BucketConfig(threshold=1.00),
        "correct":   BucketConfig(threshold=0.90),
        "follow_up": BucketConfig(threshold=0.80),
        "clarify":   BucketConfig(threshold=1.10),
        "moderate":  BucketConfig(threshold=0.60, decay_rate=1 / 600),
        "social":    BucketConfig(threshold=1.60, decay_rate=1 / 450),
    })

    # source -> (bucket, default weight). Classifier-supplied weight overrides.
    source_routing: dict[str, tuple[str, float]] = field(default_factory=lambda: {
        "direct_mention":        ("assist",    1.00),
        "explicit_question":     ("assist",    0.90),
        "unresolved_blocker":    ("assist",    0.80),
        "stalled_progress":      ("assist",    0.50),
        "high_value_suggestion": ("assist",    0.60),
        "incorrect_claim":       ("correct",   1.00),
        "promised_followup":     ("follow_up", 0.85),
        "uncertainty":           ("clarify",   0.60),
        "safety_concern":        ("moderate",  1.00),
        "topic_relevance":       ("social",    0.30),
    })

    # Flow graph: (src, tgt, per-second rate). Gradient-driven, capped.
    edges: list[tuple[str, str, float]] = field(default_factory=lambda: [
        ("clarify", "assist", 0.0006),   # confusion slowly becomes help drive
        ("social",  "assist", 0.0004),   # topic buzz feeds willingness to help
    ])
    max_edge_fraction: float = 0.5       # per tick, flow ≤ this × gradient

    # Speaking gate
    min_relevance: float = 0.45
    max_questions_per_contribution: int = 2
    contribution_budget: int = 2         # max proactive messages…
    budget_window: float = 600.0         # …per this many seconds (per channel)

    # Cooldowns (seconds) started after a proactive contribution
    cooldown_global: float = 90.0
    cooldown_channel: float = 180.0
    cooldown_user: float = 300.0
    cooldown_topic: float = 900.0
    refractory: float = 120.0            # same idempotency key ignored this long
    repeat_content_window: float = 3600.0  # same content_key blocked this long

    # Active-exchange detection (don't interrupt people mid-volley)
    exchange_window: float = 25.0        # seconds
    exchange_min_messages: int = 3       # ≥ this many human messages in window
    exchange_min_authors: int = 2        # from ≥ this many distinct humans

    # Satisfaction / staleness
    confidence_floor: float = 0.25
    topic_abandon_after: float = 600.0   # topic unmentioned this long → abandoned

    # Metabolism: speaking energy (adapted ATP)
    energy_max: float = 1.0
    energy_cost: float = 0.40            # per proactive contribution
    energy_regen: float = 1 / 900        # per second

    # Bounded queues
    max_active_signals: int = 200        # weakest evicted beyond this
    max_decisions_kept: int = 500
    max_contributions_kept: int = 200
