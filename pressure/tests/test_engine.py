"""Deterministic tests for the pressure engine. Injected clock, no network,
no LLM — run with:  python -m unittest discover pressure/tests -v
"""
from __future__ import annotations

import os
import tempfile
import unittest

from pressure import EngineConfig, PressureEngine, Proposal, Signal, SqliteStore


def sig(key, source, topic, confidence=0.9, ts=0.0, **kw):
    return Signal(key=key, source=source, weight=0, confidence=confidence,
                  ts=ts, topic=topic, channel_id="chan1", **kw)


def proposal(topic, bucket, content_key=None, **kw):
    return Proposal(topic=topic, bucket=bucket,
                    content_key=content_key or f"{topic}-point",
                    summary=f"say something about {topic}",
                    channel_id="chan1", **kw)


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.engine = PressureEngine()

    def speak_if_allowed(self, p, now):
        d = self.engine.evaluate(p, now)
        if d.allowed:
            self.engine.record_spoken(p, now)
        return d

    # 1. High-value unresolved blocker causes exactly one useful contribution.
    def test_blocker_causes_one_contribution(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
        self.engine.ingest(sig("b2", "stalled_progress", "deploy", 0.8, ts=5), 5)
        self.engine.tick(10)
        d = self.speak_if_allowed(proposal("deploy", "assist"), 10)
        self.assertTrue(d.allowed, d.reasons)
        self.assertEqual(len(self.engine.store.contributions()), 1)
        # immediately after: discharged + cooled down, cannot speak again
        d2 = self.speak_if_allowed(proposal("deploy", "assist", "another-point"), 15)
        self.assertFalse(d2.allowed)
        self.assertEqual(len(self.engine.store.contributions()), 1)

    # 2. Weak signals decay without Max speaking.
    def test_weak_signals_decay_silently(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="game")
        self.engine.ingest(sig("w1", "topic_relevance", "game", 0.5, ts=0), 0)
        for t in range(0, 4000, 200):
            self.engine.tick(t)
            d = self.engine.evaluate(proposal("game", "social"), t)
            self.assertFalse(d.allowed, f"spoke at t={t}: {d.reasons}")
        self.engine.tick(4000)
        self.assertLess(self.engine.store.get_pressures()["social"], 0.01)
        self.assertEqual(len(self.engine.store.contributions()), 0)

    # 3. Repeated signals do not produce repeated messages.
    def test_repeated_signals_no_repeat_messages(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        # identical idempotency key replayed — charges once
        for t in range(0, 50, 10):
            self.engine.ingest(sig("same-key", "unresolved_blocker", "deploy", 0.9, ts=t), t)
        self.engine.ingest(sig("other", "stalled_progress", "deploy", 0.8, ts=45), 45)
        self.engine.tick(50)
        self.speak_if_allowed(proposal("deploy", "assist", "fix-a"), 50)
        n = len(self.engine.store.contributions())
        self.assertEqual(n, 1)
        # fresh keys, same topic, right after speaking — refractory + cooldowns hold
        for t in range(60, 400, 20):
            self.engine.ingest(sig(f"k{t}", "unresolved_blocker", "deploy", 0.9, ts=t), t)
            self.engine.tick(t)
            self.speak_if_allowed(proposal("deploy", "assist", "fix-a"), t)
        self.assertEqual(len(self.engine.store.contributions()), n)

    # 4. Topic changes decay/abandon pressure without speaking.
    def test_topic_change_abandons_pressure(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
        # conversation moves on; deploy never mentioned again
        self.engine.observe_message(30, "chan1", "travis", False, topic="game")
        self.engine.tick(700)  # > topic_abandon_after past deploy's last mention
        states = {s.key: s.state for s in self.engine.store.signals(None)}
        self.assertEqual(states["b1"], "abandoned")
        d = self.engine.evaluate(proposal("deploy", "assist"), 700)
        self.assertFalse(d.allowed)
        self.assertEqual(len(self.engine.store.contributions()), 0)

    # Someone else solving it discharges without speaking.
    def test_satisfied_by_other_discharges(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
        self.engine.tick(10)
        before = self.engine.store.get_pressures()["assist"]
        self.engine.resolve(20, "satisfied", topic="deploy")
        after = self.engine.store.get_pressures()["assist"]
        self.assertLess(after, before)
        d = self.engine.evaluate(proposal("deploy", "assist"), 25)
        self.assertFalse(d.allowed)
        self.assertIn("topic is satisfied", " ".join(d.reasons))

    # Active exchange holds Max back; urgent moderation bypasses the hold.
    def test_exchange_hold_and_urgent_bypass(self):
        for t, author in [(0, "a"), (5, "b"), (8, "a"), (12, "b")]:
            self.engine.observe_message(t, "chan1", author, False, topic="argument")
        self.engine.ingest(sig("s1", "safety_concern", "argument", 0.95, ts=12), 12)
        self.engine.tick(13)
        held = self.engine.evaluate(
            proposal("argument", "moderate", urgent=False), 13)
        self.assertFalse(held.allowed)
        self.assertIn("active exchange in progress", held.reasons)
        allowed = self.engine.evaluate(
            proposal("argument", "moderate", content_key="mod-1", urgent=True), 13)
        self.assertTrue(allowed.allowed, allowed.reasons)

    # Own messages never create pressure or exchange state.
    def test_ignores_own_messages(self):
        for t in range(0, 40, 5):
            self.engine.observe_message(t, "chan1", "max", True, topic="anything")
        self.assertFalse(self.engine.exchange_active(40, "chan1"))
        self.assertEqual(self.engine.store.kv_get("msg_times:chan1", []), [])

    # Pressure is capped: cannot grow forever.
    def test_pressure_cap(self):
        for i in range(500):
            self.engine.ingest(sig(f"k{i}", "unresolved_blocker", "deploy", 1.0, ts=0), 0)
        cap = self.engine.config.buckets["assist"].cap
        self.assertLessEqual(self.engine.store.get_pressures()["assist"], cap)
        # bounded queue held too
        self.assertLessEqual(len(self.engine.store.signals("active")),
                             self.engine.config.max_active_signals)

    # Same point is never made twice, even after cooldowns lapse.
    def test_same_point_not_repeated(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
        self.engine.ingest(sig("b2", "stalled_progress", "deploy", 0.8, ts=5), 5)
        self.engine.tick(10)
        d0 = self.speak_if_allowed(proposal("deploy", "assist", "pin-libopus"), 10)
        self.assertTrue(d0.allowed, d0.reasons)
        # long after all cooldowns expire, new signal, same point
        t = 3000
        self.engine.observe_message(t, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b9", "unresolved_blocker", "deploy", 0.9, ts=t), t)
        self.engine.tick(t + 10)
        d = self.engine.evaluate(proposal("deploy", "assist", "pin-libopus"), t + 10)
        self.assertFalse(d.allowed)
        self.assertTrue(any("same point already made" in r for r in d.reasons))

    # Gate limits questions per contribution.
    def test_question_limit(self):
        self.engine.observe_message(0, "chan1", "travis", False, topic="deploy")
        self.engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
        self.engine.tick(10)
        d = self.engine.evaluate(
            proposal("deploy", "assist", question_count=3), 10)
        self.assertFalse(d.allowed)
        self.assertTrue(any("questions exceeds" in r for r in d.reasons))

    # Every evaluation is logged, allowed or not.
    def test_decisions_are_audited(self):
        self.engine.evaluate(proposal("nothing", "assist"), 0)
        decisions = self.engine.store.decisions()
        self.assertEqual(len(decisions), 1)
        self.assertFalse(decisions[0]["allowed"])
        self.assertTrue(decisions[0]["reasons"])
        self.assertIn("assist", decisions[0]["pressures"])


class PersistenceTest(unittest.TestCase):
    def test_state_survives_restart(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            engine = PressureEngine(SqliteStore(path))
            engine.observe_message(0, "chan1", "travis", False, topic="deploy")
            engine.ingest(sig("b1", "unresolved_blocker", "deploy", 0.9, ts=0), 0)
            engine.tick(10)
            engine.record_spoken(
                Proposal(topic="deploy", bucket="assist", content_key="p1",
                         summary="s", channel_id="chan1"), 10)
            pressures = engine.store.get_pressures()
            engine.store.close()

            # "restart"
            engine2 = PressureEngine(SqliteStore(path))
            self.assertEqual(engine2.store.get_pressures(), pressures)
            self.assertEqual(len(engine2.store.contributions()), 1)
            self.assertTrue(engine2.cooldowns.active(11, "chan1", "", "deploy"))
            states = {s.key: s.state for s in engine2.store.signals(None)}
            self.assertEqual(states["b1"], "spoken")
            engine2.store.close()
        finally:
            os.unlink(path)


class SimulatorTest(unittest.TestCase):
    def test_dry_run_script(self):
        from pressure.simulator import run
        lines = run()
        text = "\n".join(lines)
        spoken = [l for l in lines if "MAX SPEAKS" in l]
        # exactly two proactive contributions: the deploy fix and the GIL fix
        self.assertEqual(len(spoken), 2, text)
        self.assertIn("deploy", spoken[0])
        self.assertIn("gil", spoken[1].lower())
        # the weak social take never fires; the re-raised deploy topic is
        # held because that exact point was already made
        self.assertIn("held back (social/game)", text)
        self.assertIn("same point already made", text)


if __name__ == "__main__":
    unittest.main()
