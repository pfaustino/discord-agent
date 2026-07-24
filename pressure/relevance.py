"""Relevance evaluation boundary.

In production an LLM classifies whether a drafted contribution is relevant
to the live topic and scores it 0..1; the engine only consumes the score.
HeuristicRelevance is the deterministic stand-in used by tests and the
simulator — token overlap, no model calls.
"""
from __future__ import annotations

from typing import Protocol


class RelevanceEvaluator(Protocol):
    def score(self, proposal_topic: str, current_topic: str, summary: str) -> float: ...


class HeuristicRelevance:
    def score(self, proposal_topic: str, current_topic: str, summary: str) -> float:
        if not current_topic:
            return 0.5
        if proposal_topic == current_topic:
            return 1.0
        a = set(proposal_topic.lower().split("-")) | set(proposal_topic.lower().split())
        b = set(current_topic.lower().split("-")) | set(current_topic.lower().split())
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)
