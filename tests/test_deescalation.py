"""Deterministic tests for the de-escalation gate — every scenario the spec
names. The gate is pure logic: assessments in, decisions out, no I/O.

    python -m unittest tests.test_deescalation -v
"""
from __future__ import annotations

import unittest

from deescalation import (
    Assessment, ConflictState, decide,
    MIN_STEP_S, SETTLE_S, STAGE_IDLE, STAGE_MODS_NOTIFIED,
)


def A(ts=0.0, **kw):
    return Assessment(ts=ts, **kw)


class GateTest(unittest.TestCase):
    # Joking arguments: even with insult counts, banter reads stay silent.
    def test_joking_argument_stays_quiet(self):
        d = decide(ConflictState(), A(banter=True, targeted_insults=3,
                                      tension="rising", harsh_language=True))
        self.assertEqual(d.action, "none")
        self.assertIn("banter", " ".join(d.reasons))
        self.assertEqual(d.state.stage, STAGE_IDLE)

    # Passionate disagreement: rising tension without targeting is fine.
    def test_passionate_disagreement_stays_quiet(self):
        d = decide(ConflictState(), A(tension="rising", participants=2))
        self.assertEqual(d.action, "none")
        self.assertIn("not escalation", " ".join(d.reasons))

    # Profanity without targeting: quiet by default...
    def test_profanity_without_targeting_default_quiet(self):
        state = ConflictState()
        for t in (0, 60, 120):
            d = decide(state, A(ts=t, harsh_language=True))
            state = d.state
            self.assertEqual(d.action, "none")

    # ...but the server preference enables a check-in — and never more.
    def test_harsh_language_preference_checkin_only(self):
        state = ConflictState()
        d1 = decide(state, A(ts=0, harsh_language=True), harsh_language_pref=True)
        self.assertEqual(d1.action, "none")  # first strike: below threshold
        d2 = decide(d1.state, A(ts=30, harsh_language=True), harsh_language_pref=True)
        self.assertEqual(d2.action, "check_in")
        self.assertIn("cannot escalate", " ".join(d2.reasons))
        self.assertEqual(d2.state.stage, STAGE_IDLE)  # not on the safety ladder
        # sustained harshness afterward: cooldown holds, never suggests/notifies
        state = d2.state
        for t in (60, 120, 180):
            d = decide(state, A(ts=t, harsh_language=True), harsh_language_pref=True)
            state = d.state
            self.assertEqual(d.action, "none")

    # Direct repeated insults climb the full ladder, one restrained step at a time.
    def test_direct_insults_climb_ladder(self):
        hostile = dict(targeted_insults=2, insult_repeat=True, tension="rising")
        d1 = decide(ConflictState(), A(ts=0, **hostile))
        self.assertEqual(d1.action, "check_in")
        d2 = decide(d1.state, A(ts=MIN_STEP_S + 5, **hostile))
        self.assertEqual(d2.action, "suggest_pause")
        d3 = decide(d2.state, A(ts=2 * MIN_STEP_S + 10, **hostile))
        self.assertEqual(d3.action, "notify_mods")
        # after mods: Max stays out of it
        d4 = decide(d3.state, A(ts=3 * MIN_STEP_S, **hostile))
        self.assertEqual(d4.action, "none")
        self.assertIn("humans own it", " ".join(d4.reasons))

    # Cooldown: a second hostile read 30s after a check-in holds (no spam).
    def test_cooldown_between_steps(self):
        hostile = dict(targeted_insults=2, tension="rising")
        d1 = decide(ConflictState(), A(ts=0, **hostile))
        self.assertEqual(d1.action, "check_in")
        d2 = decide(d1.state, A(ts=30, **hostile))
        self.assertEqual(d2.action, "none")
        self.assertIn("holding", " ".join(d2.reasons))

    # Ignored stop requests count as serious on their own.
    def test_ignored_stop_request(self):
        d = decide(ConflictState(), A(ts=0, stop_ignored=True))
        self.assertEqual(d.action, "check_in")
        self.assertIn("stop", " ".join(d.reasons))

    # Credible threats skip the ladder and go straight to the moderators.
    def test_threat_fast_tracks_to_mods(self):
        d = decide(ConflictState(), A(ts=0, credible_threat=True))
        self.assertEqual(d.action, "notify_mods")
        self.assertEqual(d.state.stage, STAGE_MODS_NOTIFIED)
        # even inside a cooldown window
        d2 = decide(ConflictState(stage=0, last_action_ts=0, confirmations=1,
                                  last_serious_ts=0),
                    A(ts=10, credible_threat=True))
        self.assertEqual(d2.action, "notify_mods")

    # Cross-talk needs to be sustained (two reads), not a one-off.
    def test_crosstalk_requires_sustain(self):
        d1 = decide(ConflictState(), A(ts=0, cross_talk=True))
        self.assertEqual(d1.action, "none")
        state = d1.state  # no confirmations yet — cross_talk alone wasn't serious
        d2 = decide(ConflictState(confirmations=1, stage=STAGE_IDLE,
                                  last_serious_ts=0),
                    A(ts=30, cross_talk=True))
        self.assertEqual(d2.action, "check_in")

    # Resolved conflicts settle: falling tension resets the ladder.
    def test_resolved_conflict_disengages(self):
        hostile = dict(targeted_insults=2, tension="rising")
        d1 = decide(ConflictState(), A(ts=0, **hostile))
        self.assertEqual(d1.action, "check_in")
        d2 = decide(d1.state, A(ts=120, tension="falling"))
        self.assertEqual(d2.action, "none")
        self.assertTrue(d2.settled)
        self.assertEqual(d2.state.stage, STAGE_IDLE)
        # and a fresh flare-up starts from the bottom of the ladder again
        d3 = decide(d2.state, A(ts=200, **hostile))
        self.assertEqual(d3.action, "check_in")

    # Quiet long enough also settles, even at "steady".
    def test_quiet_period_settles(self):
        state = ConflictState(stage=0, last_action_ts=0, last_serious_ts=0,
                              confirmations=1)
        d = decide(state, A(ts=SETTLE_S + 1, tension="steady"))
        self.assertTrue(d.settled)

    # Restart safety: state round-trips through its dict form.
    def test_state_roundtrip(self):
        hostile = dict(targeted_insults=2, tension="rising")
        d1 = decide(ConflictState(), A(ts=0, **hostile))
        revived = ConflictState.from_dict(d1.state.to_dict())
        self.assertEqual(revived, d1.state)
        d2 = decide(revived, A(ts=MIN_STEP_S + 5, **hostile))
        self.assertEqual(d2.action, "suggest_pause")  # ladder position survived


if __name__ == "__main__":
    unittest.main()
