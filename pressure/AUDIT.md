# digital-pressure audit

Audit of `seed0001/digital-pressure` @ `580e5bd` for adaptation into a
Discord conversational pressure engine. Verdicts: **use** (concept taken
essentially unchanged), **adapt** (concept kept, mechanics reworked for
Discord), **reject** (not applicable, with reason).

| Component | Verdict | Why |
|---|---|---|
| Pressure buckets w/ threshold, gain, decay (`pressure_engine.py` CONFIG + `_phase_a`) | **adapt** | The bucket model (charge = weighted signals × gain, exponential decay each tick, threshold to act) is the core we keep. Reworked: the original samples continuous signal *levels* every tick (companion runtime with a permanent user present); Discord produces discrete *events*. Our buckets charge once per ingested signal and decay in continuous time, and buckets are re-derived for conversational roles (assist, correct, follow-up, clarify, moderate, social) instead of companion drives (Decompress, Bond, Conceal…). |
| Flow graph (`_phase_b`, gradient × conductance, capped) | **adapt** | Kept as an optional, configurable edge list with per-second rates and the same gradient-limited transfer, scaled down: default edges only bleed clarify→assist and social→assist. The original's 21-edge emotional circulation graph encodes companion psychology we don't want steering a moderation bot. |
| Discharge + action routing + cooldowns + action budget (`_phase_c`, `_can_fire`) | **adapt** | Threshold + cooldown + budget is necessary but not sufficient for Discord — our speaking gate adds relevance, novelty, repetition, satisfaction, and interruption checks (7 conditions). RELEASE_FRACTION-style partial discharge kept; budget kept as max contributions per window. |
| Context contracts / silence governor (`add_contract`, `_phase_a` multipliers) | **adapt** | The idea (an explicit promise of silence suppressing reach-out pressure) becomes per-scope cooldowns (global/channel/user/topic) plus a "user declined help" resolution state that discharges and cools the topic. |
| Conversation-active settling (`_is_conversation_active`, `CONVERSATION_TICK_RELIEF`) | **use** | Directly applicable: while an active exchange is running between humans, proactive pressure is settled and the gate refuses to interrupt (urgent moderation excepted). We detect activity from message timing rather than a tick counter. |
| Metabolism (ATP/fatigue/rest, `metabolism.py`) | **adapt** | Simplified to a speaking energy budget: each proactive contribution spends energy that regenerates over time; the gate requires energy. Fatigue/rest_drive/recall_gain rejected — they gate memory growth and research in the original, which we don't have. |
| Symbolic pressure memory (`pressure_memory.py`, volatile → circulated) | **reject** | It's a memory-formation system (first-contact material must circulate before it can be projected). Max already has a two-tier memory; duplicating a second memory organ inside the pressure engine couples two subsystems the spec wants separate. The one concept we keep from it: signals carry confidence and only act above a floor. |
| Journal / audit trail (`_journal`, `handle_journal`) | **use** | Kept as an append-only decision log: every gate evaluation (allowed or refused) is recorded with reasons and a pressure snapshot. |
| Persistence (`save_state`/`load_state` JSON snapshot) | **adapt** | Concept kept (full state survives restart) but moved from a JSON blob to SQLite with a schema version, per the project's storage conventions, behind a small adapter interface. |
| DRY_RUN mode | **use** | Kept as `pressure/simulator.py` — scripted transcripts drive the engine with an injected clock and print every tick/decision; no model or network calls anywhere in the core. |
| Continuous tick loop (`server.py` tick thread) | **adapt** | The engine is tick-*driven* but not tick-*looping*: `tick(now)` is a pure function of elapsed time, called by the host (or the simulator). No background thread inside the engine — the caller owns scheduling, which keeps tests deterministic. |
| Conversation analyzer (`conversation_analyzer.py`) | **reject** | It's an LLM/heuristic classifier producing signal levels. Per spec, classification is the pluggable LLM's job at the boundary; the engine only consumes already-structured signals. A deterministic heuristic relevance evaluator is included for tests. |
| Mycelial field (`mycelial_field.py`) | **reject** | Vector/token memory organ for the companion's recall — out of scope, overlaps Max's existing memory. |
| Ecology bridge (`ecology_bridge.py`) | **reject** | Maps artificial-life metrics (entropy, lineage flux) into pressure. No counterpart in a Discord server. |
| Vision / presence (`vision_sensor.py`, `remote_vision_client.py`) | **reject** | Camera presence signals; Discord has no visual presence. Voice-channel presence is already an explicit signal source. |
| Social dynamics / knowledge graph / concept engine | **reject** | Companion-relationship modeling (trust, boundary, concealment). A server bot deciding when to interject doesn't need a trust ledger; the distrust/conceal buckets they feed are exactly the "assumptions incompatible with Discord conversations" the spec warns about. |
| TTS / server / dashboard (`server.py`, `edge_tts_speak.js`) | **reject** | The live bot already has its own TTS and dashboard; the engine stays headless. |

## Concepts preserved end-to-end

Charge → flow → decay → discharge → metabolism, pressure buckets,
partial-release discharge, cooldown-gated actions, action budgets,
conversation-active settling, dry-run simulation, full-state persistence,
and an audit journal. Everything embodied/companion-specific is left behind.
