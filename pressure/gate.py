"""The speaking gate: all conditions must pass before Max speaks unprompted.

Deterministic code enforces every condition. The LLM may have drafted the
proposal and scored its relevance upstream, but nothing here trusts it to
self-limit.
"""
from __future__ import annotations

from .config import EngineConfig
from .cooldowns import CooldownManager
from .models import Decision, Proposal
from .store import SqliteStore


class SpeakingGate:
    def __init__(self, store: SqliteStore, config: EngineConfig, cooldowns: CooldownManager):
        self.store = store
        self.config = config
        self.cooldowns = cooldowns

    def evaluate(
        self,
        proposal: Proposal,
        now: float,
        pressures: dict[str, float],
        topic_pressure: float,
        exchange_active: bool,
        energy: float,
        topic_state: str,
    ) -> Decision:
        c = self.config
        reasons: list[str] = []
        bucket_cfg = c.buckets.get(proposal.bucket)

        # 1. total relevant pressure over threshold
        if bucket_cfg is None:
            reasons.append(f"unknown bucket {proposal.bucket!r}")
        elif topic_pressure < bucket_cfg.threshold:
            reasons.append(
                f"pressure {topic_pressure:.2f} below threshold {bucket_cfg.threshold:.2f}")

        # 2. relevant to the current topic
        if proposal.relevance < c.min_relevance:
            reasons.append(f"relevance {proposal.relevance:.2f} below {c.min_relevance}")

        # 3. new, useful information or action
        if not proposal.provides_new_info:
            reasons.append("adds no new information or action")
        if proposal.question_count > c.max_questions_per_contribution:
            reasons.append(
                f"{proposal.question_count} questions exceeds max "
                f"{c.max_questions_per_contribution}")

        # 4. same point not already made
        for contrib in self.store.contributions():
            if contrib.content_key == proposal.content_key and \
                    now - contrib.ts < c.repeat_content_window:
                reasons.append(f"same point already made at t={contrib.ts:.0f}")
                break

        # 5. no active cooldowns
        held = self.cooldowns.active(now, proposal.channel_id, proposal.user_id, proposal.topic)
        if held:
            reasons.append("cooldown active: " + ", ".join(held))

        # 6. target issue still live
        if topic_state != "active":
            reasons.append(f"topic is {topic_state}")

        # 7. don't interrupt an active exchange (urgent moderation excepted)
        if exchange_active and not proposal.urgent:
            reasons.append("active exchange in progress")

        # budget: proactive contributions per channel per window
        recent = [
            x for x in self.store.contributions()
            if x.channel_id == proposal.channel_id and now - x.ts < c.budget_window
        ]
        if len(recent) >= c.contribution_budget:
            reasons.append(
                f"budget spent ({len(recent)}/{c.contribution_budget} in window)")

        # metabolism: enough energy to speak
        if energy < c.energy_cost:
            reasons.append(f"energy {energy:.2f} below cost {c.energy_cost}")

        decision = Decision(
            ts=now,
            allowed=not reasons,
            reasons=reasons or ["all gate conditions passed"],
            proposal_topic=proposal.topic,
            proposal_bucket=proposal.bucket,
            proposal_summary=proposal.summary[:200],
            channel_id=proposal.channel_id,
            pressures={k: round(v, 4) for k, v in pressures.items()},
        )
        self.store.add_decision(decision, self.config.max_decisions_kept)
        return decision
