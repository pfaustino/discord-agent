# The voice pipeline (technical deep-dive)

How Max hears, understands, and speaks — and why it's built the way it is.

## The DAVE problem

On March 2, 2026, Discord globally enforced end-to-end encryption (the
DAVE protocol) for non-Stage voice. Consequences discovered the hard way:

- discord.py < 2.7 has no DAVE → kicked at the voice handshake with error
  4017 in a connect/disconnect loop
- discord.py ≥ 2.7 connects (it can *send*), but received audio frames are
  E2EE and the Python voice-receive ecosystem (discord-ext-voice-recv,
  Pycord sinks) cannot decrypt them — packets decode to garbage
  ("OpusError: corrupted stream")

**No Python stack can receive voice audio.** discord.js can — its voice
library supports DAVE via `@snazzah/davey`, including decryption of
received frames. Hence the hybrid: Python brain, Node ears.

## Capture (sidecar, `listener/index.js`)

1. Second gateway session with the same bot token; only this process
   touches voice. Auto-join policy: busiest occupied voice channel per
   guild, leave when empty, rebalance sweep every 30s (also the retry path
   for startup races and the recovery path for zombie connections stuck
   out of the Ready state >60s).
2. Discord delivers **per-speaker** Opus streams (SSRC-mapped) — speaker
   separation is protocol-native, no diarization needed.
3. `EndBehaviorType.AfterSilence` (1000ms) segments utterances. A 90s
   watchdog force-closes stalled subscriptions so a speaker can't get
   stuck "subscribed but unheard".
4. Noise gates before anything is sent: minimum duration
   (`MIN_UTTERANCE_SEC`, default 1.5s) and minimum RMS loudness
   (`MIN_UTTERANCE_RMS`, default 300/32768). Background blips die here,
   unbilled.
5. Raw PCM (48kHz stereo s16le) POSTs to `/internal/utterance` with
   guild/channel/user headers, authed by `SECRET_KEY`.

## Understanding (Python, `bot/cogs/voice.py` + `transcription.py`)

1. PCM → WAV → OpenAI-compatible `/audio/transcriptions` (Whisper et al),
   concurrency-capped.
2. Hallucination defenses: a blocklist of Whisper's noise-artifacts
   ("thank you", "bye-bye", filler words), plus per-user suppression of
   identical short phrases repeated within 45s.
3. Surviving text fans out to: the rolling per-channel transcript (drives
   the dashboard Voice console), banned-word flags → mod log, the memory
   system, pressure-signal classification, and wake-word detection.

## Speaking (`tts.py` + sidecar playback)

Two triggers:
- **Wake word** ("hey max", configurable): reply is generated with the
  last ~40 transcript lines as context; TTS audio returns to the sidecar
  in the same HTTP response that delivered the utterance.
- **Proactive** (pressure gate opens on a voice-channel topic): Python
  pushes TTS to the sidecar's `POST /speak` control endpoint — but only
  after verifying the sidecar is connected to that exact channel.

TTS synthesis: Fish Audio, model `s2.1-pro-free` by default. S2 models
take free-form `[voice direction]` tags and `(laugh)`/`(sigh)` paralanguage
which the drafting prompt teaches Max to use; S1 uses a fixed parenthesis
vocabulary; tag style is selected automatically from `FISH_TTS_MODEL`.
Tags go to the synthesizer only — text chat and transcripts get a stripped
clean version. No Fish key (or any Fish failure) falls back to edge-tts.
Playback: mp3 → ffmpeg → Opus → the voice connection, skipped if already
speaking.

## Failure modes and how they're handled

| Failure | Handling |
|---|---|
| Sidecar process dies | main.py restarts it with backoff |
| Voice connection zombies (no events, deaf) | 60s not-Ready detector tears down and rejoins |
| Subscription stalls (no silence event) | 90s watchdog force-closes |
| Python/side race at boot | config fetch retries at 5s/15s + 30s sweep |
| Gateway dies silently | liveness watchdog force-restarts container after 5 min |
| Transcription API down | utterances drop with warnings; everything else unaffected |
| TTS fails | text-only reply, logged |
