# pressure — conversational pressure engine (isolated, test-only)

Decides whether Max has *earned* the right to speak without being addressed.
Pressure accumulates from weighted signals, decays and flows over time, and a
deterministic speaking gate rules on every proposed contribution. Adapted
from `seed0001/digital-pressure` — see [AUDIT.md](AUDIT.md) for the
component-by-component audit.

**Not wired into the live bot.** Nothing under `bot/`, `web/`, or
`listener/` imports this package. It lives on the `experiment/pressure-engine`
branch only.

## Model

- **Signals** (`models.Signal`) — source, weight, confidence, timestamp,
  topic, decay policy, max lifetime, evidence, terminal state. Idempotency
  keys make replays free.
- **Buckets** (`config.EngineConfig.buckets`) — assist / correct / follow_up /
  clarify / moderate / social, each with threshold, gain, decay, cap, and
  release fraction. Charge on ingest, exponential decay per tick, optional
  gradient flow along configured edges, hard caps.
- **Speaking gate** (`gate.SpeakingGate`) — all conditions must pass:
  topic-scoped pressure over threshold, relevance, novelty, not-a-repeat,
  no cooldowns (global/channel/user/topic), issue still live, no active
  exchange being interrupted (urgent moderation excepted), budget not spent,
  enough energy. Every evaluation is logged pass or fail.
- **Discharge** (`engine.record_spoken`) — partial pressure release, signals
  marked spoken, cooldowns started, contribution recorded for repetition
  history, energy spent.
- **Satisfaction** (`engine.resolve` + tick expiry) — solved-by-other,
  declined, abandoned-on-topic-change, stale, low-confidence, and
  max-lifetime all discharge without speaking.
- **Persistence** (`store.SqliteStore`) — full state (signals, pressures,
  cooldowns, contributions, decisions, schema version) survives restarts.
- **The LLM's only jobs** (upstream, pluggable): classify messages into
  signals, draft proposals, score relevance (`relevance.RelevanceEvaluator`).
  Deterministic code enforces every limit.

## Run it

```bash
python -m unittest discover -s pressure/tests -t .   # 13 deterministic tests
python -m pressure.simulator                          # scripted dry run
```

The simulator prints a tick-by-tick timeline: what charged, what Max said,
and — more importantly — every time he was held back and exactly why.
