"""Isolated, test-only conversational pressure engine for Max.

Decides whether the bot should speak without being addressed: pressure
accumulates from weighted signals, decays and flows over time, and a
deterministic speaking gate (thresholds, relevance, novelty, repetition,
cooldowns, satisfaction, interruption, budget, energy) rules on proposals.

NOT wired into the live bot. See AUDIT.md for the digital-pressure audit
and README.md for usage.
"""
from .config import BucketConfig, EngineConfig
from .engine import PressureEngine
from .models import Contribution, Decision, Proposal, Signal
from .relevance import HeuristicRelevance
from .store import SqliteStore

__all__ = [
    "BucketConfig", "Contribution", "Decision", "EngineConfig",
    "HeuristicRelevance", "PressureEngine", "Proposal", "Signal", "SqliteStore",
]
