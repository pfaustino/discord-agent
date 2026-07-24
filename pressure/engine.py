"""The pressure engine: decides whether Max has earned the right to speak
without being addressed.

Deterministic core — no wall clock (callers pass `now`), no network, no LLM.
The LLM's only roles upstream: classify messages into Signals and draft
Proposals with a relevance score. Everything that limits behavior
(thresholds, cooldowns, budgets, repetition, discharge) is enforced here.

Lifecycle per host loop:
    engine.observe_message(...)   # every message (incl. Max's own)
    engine.ingest(signal)         # classifier output
    engine.tick(now)              # charge decay, flow, expiry, satisfaction
    decision = engine.evaluate(proposal, now)
    if decision.allowed:
        ...send the message...
        engine.record_spoken(proposal, now)   # discharge + cooldowns
"""
from __future__ import annotations

import math
import threading

from .config import EngineConfig
from .cooldowns import CooldownManager
from .gate import SpeakingGate
from .models import Contribution, Decision, Proposal, Signal
from .store import SqliteStore


class PressureEngine:
    def __init__(self, store: SqliteStore | None = None, config: EngineConfig | None = None):
        self.store = store or SqliteStore(":memory:")
        self.config = config or EngineConfig()
        self.cooldowns = CooldownManager(self.store, self.config)
        self.gate = SpeakingGate(self.store, self.config, self.cooldowns)
        self._lock = threading.Lock()  # one worker acts at a time
        pressures = self.store.get_pressures()
        for name in self.config.buckets:
            pressures.setdefault(name, 0.0)
        self.store.set_pressures(pressures)
        if self.store.kv_get("energy") is None:
            self.store.kv_set("energy", self.config.energy_max)
        if self.store.kv_get("last_tick") is None:
            self.store.kv_set("last_tick", None)

    # -- observation ---------------------------------------------------------

    def observe_message(self, now: float, channel_id: str, author_id: str,
                        is_self: bool, topic: str = "") -> None:
        """Track message flow for exchange detection, topic recency, and the
        self-trigger guard. Max's own messages never generate pressure."""
        if not is_self:
            times = self.store.kv_get(f"msg_times:{channel_id}", [])
            times = [t for t in times if now - t[0] < self.config.exchange_window * 2]
            times.append((now, author_id))
            self.store.kv_set(f"msg_times:{channel_id}", times[-30:])
        if topic:
            self.store.kv_set(f"topic_seen:{topic}", now)
            self.store.kv_set("current_topic", topic)

    def exchange_active(self, now: float, channel_id: str) -> bool:
        c = self.config
        times = self.store.kv_get(f"msg_times:{channel_id}", [])
        recent = [t for t in times if now - t[0] < c.exchange_window]
        authors = {t[1] for t in recent}
        return len(recent) >= c.exchange_min_messages and len(authors) >= c.exchange_min_authors

    # -- signal collection ---------------------------------------------------

    def ingest(self, signal: Signal, now: float | None = None) -> bool:
        """Add a signal. Returns False if dropped (idempotent replay,
        refractory period, unknown source, or below confidence floor)."""
        with self._lock:
            now = signal.ts if now is None else now
            if signal.source not in self.config.source_routing:
                return False
            if signal.confidence < self.config.confidence_floor:
                return False

            existing = self.store.get_signal(signal.key)
            if existing is not None:
                if existing.state == "active":
                    return False  # idempotent: same key never charges twice
                # a resolved signal's key stays quiet during refractory
                if existing.resolved_ts is not None and \
                        now - existing.resolved_ts < self.config.refractory:
                    return False
                existing.resolve("superseded", now)
                self.store.upsert_signal(existing)
                signal.key = f"{signal.key}#r{int(now)}"

            bucket_name, default_weight = self.config.source_routing[signal.source]
            if signal.weight <= 0:
                signal.weight = default_weight

            # bounded queue: evict the weakest active signal when full
            active = self.store.signals("active")
            if len(active) >= self.config.max_active_signals:
                weakest = min(active, key=lambda s: s.strength(now))
                weakest.resolve("expired", now)
                self.store.upsert_signal(weakest)

            self.store.upsert_signal(signal)

            # charge the bucket (capped — pressure can never grow forever)
            cfg = self.config.buckets[bucket_name]
            pressures = self.store.get_pressures()
            charge = cfg.gain * signal.weight * signal.confidence
            pressures[bucket_name] = min(cfg.cap, pressures[bucket_name] + charge)
            self.store.set_pressures(pressures)
            self.store.kv_set(f"topic_seen:{signal.topic}", now)
            return True

    # -- metabolism / decay / flow (the tick) --------------------------------

    def tick(self, now: float) -> None:
        with self._lock:
            last = self.store.kv_get("last_tick")
            self.store.kv_set("last_tick", now)
            dt = max(0.0, now - last) if last is not None else 0.0
            if dt == 0.0:
                self._expire_signals(now)
                return

            pressures = self.store.get_pressures()

            # decay
            for name, cfg in self.config.buckets.items():
                pressures[name] *= math.exp(-cfg.decay_rate * dt)

            # flow along edges (gradient-driven, capped)
            for src, tgt, rate in self.config.edges:
                gradient = pressures[src] - pressures[tgt]
                if gradient <= 0:
                    continue
                flow = min(gradient * rate * dt, gradient * self.config.max_edge_fraction)
                pressures[src] -= flow
                tgt_cap = self.config.buckets[tgt].cap
                pressures[tgt] = min(tgt_cap, pressures[tgt] + flow)

            self.store.set_pressures({k: round(v, 6) for k, v in pressures.items()})

            # energy regen
            energy = min(self.config.energy_max,
                         (self.store.kv_get("energy") or 0) + self.config.energy_regen * dt)
            self.store.kv_set("energy", energy)

            self._expire_signals(now)

    def _expire_signals(self, now: float) -> None:
        current_topic = self.store.kv_get("current_topic") or ""
        for s in self.store.signals("active"):
            if now - s.ts >= s.max_lifetime:
                self._resolve_signal(s, "expired", now)
            elif s.confidence < self.config.confidence_floor:
                self._resolve_signal(s, "low_confidence", now)
            elif s.topic and s.topic != current_topic:
                last_seen = self.store.kv_get(f"topic_seen:{s.topic}") or s.ts
                if now - last_seen > self.config.topic_abandon_after:
                    self._resolve_signal(s, "abandoned", now)

    # -- satisfaction --------------------------------------------------------

    def resolve(self, now: float, reason: str, topic: str | None = None,
                key: str | None = None) -> int:
        """Externally-observed resolution: someone else solved it, the user
        declined, the goal completed, etc. Discharges associated pressure."""
        with self._lock:
            count = 0
            for s in self.store.signals("active"):
                if key is not None and s.key != key:
                    continue
                if key is None and topic is not None and s.topic != topic:
                    continue
                self._resolve_signal(s, reason, now)
                count += 1
            return count

    def _resolve_signal(self, s: Signal, reason: str, now: float) -> None:
        """Mark resolved and discharge its remaining charge from its bucket."""
        strength = s.strength(now)
        s.resolve(reason, now)
        self.store.upsert_signal(s)
        bucket_name, _ = self.config.source_routing.get(s.source, (None, 0))
        if bucket_name:
            cfg = self.config.buckets[bucket_name]
            pressures = self.store.get_pressures()
            pressures[bucket_name] = max(0.0, pressures[bucket_name] - cfg.gain * strength)
            self.store.set_pressures(pressures)

    # -- relevance-scoped pressure -------------------------------------------

    def topic_pressure(self, bucket: str, topic: str, now: float) -> float:
        """Bucket pressure scaled by how much of its live signal strength is
        about this topic — pressure about other things doesn't justify
        speaking about this one."""
        pressures = self.store.get_pressures()
        total_strength = 0.0
        topic_strength = 0.0
        for s in self.store.signals("active"):
            b, _ = self.config.source_routing.get(s.source, (None, 0))
            if b != bucket:
                continue
            strength = s.strength(now)
            total_strength += strength
            if s.topic == topic:
                topic_strength += strength
        if total_strength <= 0:
            return 0.0
        return pressures.get(bucket, 0.0) * (topic_strength / total_strength)

    # -- the gate ------------------------------------------------------------

    def evaluate(self, proposal: Proposal, now: float) -> Decision:
        with self._lock:
            topic_state = "active"
            live = [s for s in self.store.signals("active")
                    if s.topic == proposal.topic and s.strength(now) > 0]
            if not live:
                resolved = [s for s in self.store.signals(None)
                            if s.topic == proposal.topic and s.state != "active"]
                topic_state = resolved[-1].state if resolved else "expired"
            return self.gate.evaluate(
                proposal=proposal,
                now=now,
                pressures=self.store.get_pressures(),
                topic_pressure=self.topic_pressure(proposal.bucket, proposal.topic, now),
                exchange_active=self.exchange_active(now, proposal.channel_id),
                energy=self.store.kv_get("energy") or 0.0,
                topic_state=topic_state,
            )

    # -- discharge -----------------------------------------------------------

    def record_spoken(self, proposal: Proposal, now: float) -> None:
        """After Max actually speaks: discharge, record, cool down."""
        with self._lock:
            cfg = self.config.buckets[proposal.bucket]
            pressures = self.store.get_pressures()
            pressures[proposal.bucket] = max(
                0.0, pressures[proposal.bucket] * (1 - cfg.release_fraction))
            self.store.set_pressures(pressures)

            for s in self.store.signals("active"):
                if s.topic == proposal.topic:
                    s.resolve("spoken", now)
                    self.store.upsert_signal(s)

            self.store.add_contribution(
                Contribution(ts=now, topic=proposal.topic, bucket=proposal.bucket,
                             content_key=proposal.content_key, summary=proposal.summary,
                             channel_id=proposal.channel_id),
                self.config.max_contributions_kept)
            self.cooldowns.start_all(now, proposal.channel_id, proposal.user_id, proposal.topic)
            self.store.kv_set(
                "energy", max(0.0, (self.store.kv_get("energy") or 0) - self.config.energy_cost))

    # -- inspection ----------------------------------------------------------

    def snapshot(self, now: float) -> dict:
        return {
            "pressures": self.store.get_pressures(),
            "energy": self.store.kv_get("energy"),
            "active_signals": [
                {"key": s.key, "source": s.source, "topic": s.topic,
                 "strength": round(s.strength(now), 4), "evidence": s.evidence}
                for s in self.store.signals("active")
            ],
            "cooldowns": {k: round(v - now, 1)
                          for k, v in self.store.get_cooldowns().items() if v > now},
            "contributions": len(self.store.contributions()),
            "decisions": len(self.store.decisions()),
        }
