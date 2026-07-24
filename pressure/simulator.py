"""Dry-run simulator: drive the engine with a scripted conversation and an
injected clock; print every pressure change and gate decision. No model, no
network, no Discord.

    python -m pressure.simulator
"""
from __future__ import annotations

from .config import EngineConfig
from .engine import PressureEngine
from .models import Proposal, Signal
from .relevance import HeuristicRelevance

# A scripted afternoon: two people hit a deploy blocker, chat drifts, someone
# makes a wrong claim, the blocker gets solved by a human, topic moves on.
SCRIPT = [
    (0,    "msg", "travis", "so the deploy keeps failing on the opus step", "deploy"),
    (5,    "sig", dict(key="blk1", source="unresolved_blocker", confidence=0.9,
                       topic="deploy", evidence="deploy failing, no fix in thread")),
    (20,   "msg", "buddy", "yeah I hit that too, no idea", "deploy"),
    (25,   "sig", dict(key="blk2", source="stalled_progress", confidence=0.7,
                       topic="deploy", evidence="both stuck, thread stalled")),
    (40,   "try", dict(topic="deploy", bucket="assist",
                       content_key="deploy-opus-fix",
                       summary="suggest pinning libopus via apt", questions=0)),
    (60,   "msg", "travis", "anyway did you watch the game", "game"),
    (65,   "sig", dict(key="rel1", source="topic_relevance", confidence=0.5,
                       topic="game", evidence="casual topic drift")),
    (80,   "try", dict(topic="game", bucket="social", content_key="game-hot-take",
                       summary="drop a take about the game", questions=0)),
    (250,  "msg", "buddy", "python threads run in parallel because of the GIL", "python"),
    (255,  "sig", dict(key="wrong1", source="incorrect_claim", confidence=0.95,
                       topic="python", evidence="GIL claim is backwards")),
    (270,  "try", dict(topic="python", bucket="correct", content_key="gil-correction",
                       summary="gently correct the GIL claim", questions=0)),
    # much later: someone re-raises the deploy thing Max already addressed
    (2000, "msg", "travis", "ugh the deploy thing again", "deploy"),
    (2005, "sig", dict(key="blk3", source="unresolved_blocker", confidence=0.9,
                       topic="deploy", evidence="deploy topic re-raised")),
    (2010, "try", dict(topic="deploy", bucket="assist", content_key="deploy-opus-fix",
                       summary="suggest pinning libopus via apt", questions=0)),
]


def run(script=SCRIPT, config: EngineConfig | None = None) -> list[str]:
    engine = PressureEngine(config=config)
    relevance = HeuristicRelevance()
    lines: list[str] = []

    def out(s: str) -> None:
        lines.append(s)

    for t, kind, *rest in script:
        engine.tick(float(t))
        if kind == "msg":
            author, text, topic = rest
            engine.observe_message(float(t), "chan1", author, is_self=False, topic=topic)
            out(f"[{t:>4}s] {author}: {text}")
        elif kind == "sig":
            d = rest[0]
            sig = Signal(key=d["key"], source=d["source"], weight=0,
                         confidence=d["confidence"], ts=float(t), topic=d["topic"],
                         channel_id="chan1", evidence=d.get("evidence", ""))
            accepted = engine.ingest(sig, float(t))
            out(f"[{t:>4}s]   signal {d['source']}({d['topic']}) "
                f"conf={d['confidence']} -> {'charged' if accepted else 'dropped'}")
        elif kind == "resolve":
            d = rest[0]
            n = engine.resolve(float(t), d["reason"], topic=d.get("topic"))
            out(f"[{t:>4}s]   resolve({d['topic']}, {d['reason']}) -> {n} signal(s)")
        elif kind == "try":
            d = rest[0]
            current_topic = engine.store.kv_get("current_topic") or ""
            proposal = Proposal(
                topic=d["topic"], bucket=d["bucket"], content_key=d["content_key"],
                summary=d["summary"], question_count=d.get("questions", 0),
                relevance=relevance.score(d["topic"], current_topic, d["summary"]),
                channel_id="chan1")
            decision = engine.evaluate(proposal, float(t))
            if decision.allowed:
                engine.record_spoken(proposal, float(t))
                out(f"[{t:>4}s] >>> MAX SPEAKS ({d['bucket']}/{d['topic']}): {d['summary']}")
            else:
                out(f"[{t:>4}s]   held back ({d['bucket']}/{d['topic']}): "
                    + "; ".join(decision.reasons))
        snap = engine.snapshot(float(t))
        pressures = ", ".join(f"{k}={v:.2f}" for k, v in snap["pressures"].items() if v > 0.01)
        out(f"        pressures: {pressures or '(all ~0)'} | energy={snap['energy']:.2f}")
    return lines


if __name__ == "__main__":
    print("\n".join(run()))
