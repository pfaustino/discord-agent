# Documents

Six documents. Four describe the project as it actually stands; two describe
the business being built on top of it.

| | |
|---|---|
| [01 — The project](01-the-project.md) | What this is, what it does, and who it is for |
| [02 — How it works](02-how-it-works.md) | Architecture, the two pipelines, memory, credits, backends |
| [03 — Running it](03-running-it.md) | Deploy, configuration, incidents, the failures that actually happen |
| [04 — State of play](04-state-of-play.md) | What is real, what is not, what will bite, what is next |
| [05 — Service model](05-service-model.md) | Bot as a Service: what we sell and how a customer moves through it |
| [06 — Operating model](06-operating-model.md) | The partner circle, redundancy, and the shared plumbing |

## How to read these

**01–04 are descriptive.** They document a system that exists and can be run
today. Where something is aspirational it says so in those words. If you find
a claim in here that the code does not support, that is a bug in the document
and worth fixing on the spot — the whole point is that these can be trusted
without reading the source first.

**05–06 are a working draft.** They grew out of the *Bot as a Service —
Working Outline* (v0.1) and keep its stance: a thinking document, not a plan
of record. They are more opinionated than 01–04 on purpose, and every open
question is still labelled open. Argue with them.

## Relationship to `docs/`

`docs/` came first and holds long-form deep-dives written while the bot was
being built: `how-max-thinks.md` in particular is a 490-line study of the
reasoning architecture that nothing here replaces.

**Some of `docs/` is now stale.** It predates the Node cutover and everything
built since. The clearest example: `docs/operations.md` says the deploy runs
`python main.py`, which has not been true for some time — the entry point is
`node --experimental-sqlite nodebot/src/index.js`. Treat `documents/03` as
authoritative on operations and `docs/operations.md` as history.

Worth folding the two folders together at some point. Not urgent, but the
longer two sets of documentation disagree, the less either gets trusted.

## Keeping them honest

The repository already enforces this idea in code — `nodebot/test/systemPrompt.test.js`
fails the build if the bot's own capability description names a tool that does
not exist, because an earlier version advertised eight commands it never had.
These documents deserve the same discipline, applied by hand: when behaviour
changes, the document changes in the same commit.
