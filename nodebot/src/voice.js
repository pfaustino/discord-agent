// Voice: join/leave/rebalance is a direct port of listener/index.js's
// proven logic (DAVE E2EE join, per-speaker capture, silence-cut
// utterances) — no reason to rewrite working audio-plumbing code. What's
// new here is that content decisions (transcribe, wake word, reply, TTS)
// happen in THIS SAME process and read/write conversation.js's shared
// buffer — the same one textChat.js uses. That's the actual fix for the
// Python bot's split: there is no longer an HTTP hop and no longer a
// second, separate transcript the model's context doesn't include.
import { Readable } from 'node:stream';
import { ChannelType } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, EndBehaviorType,
  createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, VoiceConnectionStatus, entersState,
} from '@discordjs/voice';
import prism from 'prism-media';

import { VOICE_WAKE_WORDS, VOICE_CANCEL_WORDS } from './config.js';
import { chat, OpenRouterError } from './openrouter.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { SYSTEM_PROMPT, VOICE_PROMPT } from './persona.js';
import * as transcription from './transcription.js';
import * as tts from './tts.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';

const SILENCE_MS = 1000;                 // silence gap that ends an utterance
const MIN_UTTERANCE_SEC = 1.5;            // shorter blips are the noise gate, not speech
const MIN_PCM_BYTES = 48000 * 2 * 2 * MIN_UTTERANCE_SEC;
const MIN_RMS = 300;                      // loudness floor
const STUCK_CONNECTION_MS = 60_000;
const WAKE_COOLDOWN_MS = 8_000;
const WAKE_GRACE_MS = 1_000;              // window for an instant "never mind"
const REPEAT_SUPPRESS_MS = 45_000;
const REPEAT_MAX_CHARS = 30;
const CONTEXT_TURNS = 40;
const MAX_TOOL_ROUNDS = 4;

const activeStreams = new Set();     // "guildId:userId" with a live subscription
const players = new Map();           // guildId -> AudioPlayer
const manualHold = new Map();        // guildId -> channelId pinned via a join command
const notReadySince = new Map();     // guildId -> ms timestamp connection left Ready
const lastWake = new Map();          // channelId -> ms timestamp
const lastText = new Map();          // userId -> [normalizedText, ms timestamp]
const pendingWake = new Map();       // channelId -> { cancelled, controller }

function humanCount(channel) {
  return channel.members.filter((m) => !m.user.bot).size;
}

function voiceChannels(guild) {
  return guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice);
}

export function matchesAny(text, words) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.some((w) => normalized.includes(w));
}

// -- join/leave/rebalance (ported from listener/index.js) -------------------

async function joinChannel(channel) {
  console.log(`[voice] joining #${channel.name} (${channel.id})`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  connection.receiver.speaking.on('start', (userId) => {
    subscribeUser(connection, channel.guild, channel, userId);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      setTimeout(() => rebalance(channel.guild).catch(() => {}), 2_000);
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[voice] failed to become ready in #${channel.name}:`, err.message);
    connection.destroy();
    return;
  }
  console.log(`[voice] listening in #${channel.name}`);
  const hint = VOICE_WAKE_WORDS.length ? ` Say "${VOICE_WAKE_WORDS[0]}" to bring me into the conversation.` : '';
  try {
    await channel.send(`🎙️ Heads-up: an AI is listening to this channel and transcribing speech.${hint}`);
  } catch (err) {
    console.warn('[voice] join announcement failed:', err.message);
  }
}

function leaveGuild(guild) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return;
  connection.destroy();
  players.delete(guild.id);
}

async function rebalance(guild) {
  let connection = getVoiceConnection(guild.id);

  // Zombie detection: a connection stuck out of Ready (dead UDP, missed
  // disconnect event) is silently deaf — tear it down and rejoin.
  if (connection) {
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      notReadySince.delete(guild.id);
    } else {
      const since = notReadySince.get(guild.id) || Date.now();
      notReadySince.set(guild.id, since);
      if (Date.now() - since > STUCK_CONNECTION_MS) {
        console.warn(`[voice] connection stuck in '${connection.state.status}' — rebuilding`);
        notReadySince.delete(guild.id);
        leaveGuild(guild);
        connection = null;
      } else {
        return; // still within grace period, give it time to recover
      }
    }
  }

  const held = manualHold.get(guild.id);
  if (held) {
    const heldChannel = guild.channels.cache.get(held);
    if (!heldChannel || humanCount(heldChannel) === 0) {
      manualHold.delete(guild.id); // pinned channel emptied — resume auto mode
    } else if (connection && connection.joinConfig.channelId === held) {
      return;
    }
  }

  const current = connection && guild.channels.cache.get(connection.joinConfig.channelId);
  if (connection && current && humanCount(current) > 0) return; // stay put
  const occupied = voiceChannels(guild)
    .filter((c) => humanCount(c) > 0)
    .sort((a, b) => humanCount(b) - humanCount(a));
  if (connection) leaveGuild(guild);
  const target = occupied.first();
  if (target) await joinChannel(target);
}

export async function rebalanceAll(client) {
  for (const guild of client.guilds.cache.values()) {
    await rebalance(guild).catch((err) => console.error('[voice] rebalance:', err.message));
  }
}

export function init(client) {
  if (!transcription.available()) {
    console.warn('[voice] TRANSCRIPTION_API_KEY not set — voice monitoring disabled');
    return;
  }
  rebalanceAll(client);
  for (const delay of [5_000, 15_000]) setTimeout(() => rebalanceAll(client), delay);
  setInterval(() => rebalanceAll(client), 30_000);
}

export function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (member?.user.bot) return;
  const guild = newState.guild || oldState.guild;
  rebalance(guild).catch((err) => console.error('[voice] rebalance:', err.message));
}

// -- audio receive ------------------------------------------------------------

function pcmRms(buf) {
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  const step = Math.max(1, Math.floor(samples / 4000));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples; i += step) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

function subscribeUser(connection, guild, channel, userId) {
  const key = `${guild.id}:${userId}`;
  if (activeStreams.has(key)) return;
  const member = guild.members.cache.get(userId);
  if (member?.user.bot) return;
  activeStreams.add(key);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  decoder.on('data', (chunk) => chunks.push(chunk));

  const watchdog = setTimeout(() => {
    console.warn(`[voice] subscription watchdog fired for user ${userId}`);
    try { opusStream.destroy(); } catch { /* already gone */ }
    try { decoder.destroy(); } catch { /* already gone */ }
    finish();
  }, 90_000);

  const finish = () => {
    clearTimeout(watchdog);
    if (!activeStreams.delete(key)) return; // already finished
    const pcm = Buffer.concat(chunks);
    if (pcm.length < MIN_PCM_BYTES) return; // too short — noise blip
    const rms = pcmRms(pcm);
    if (rms < MIN_RMS) {
      console.log(`[voice] dropped quiet blip (rms ${Math.round(rms)}) from ${userId}`);
      return;
    }
    handleUtterance(guild, channel, userId, pcm)
      .catch((err) => console.error('[voice] utterance handling failed:', err.message));
  };
  decoder.once('end', finish);
  decoder.once('close', finish);
  decoder.once('error', (err) => { console.error('[voice] decode error:', err.message); finish(); });
  opusStream.once('error', (err) => { console.error('[voice] stream error:', err.message); decoder.destroy(); });
  opusStream.pipe(decoder);
}

// -- content: transcribe, remember, wake word, reply -------------------------

async function handleUtterance(guild, channel, userId, pcm) {
  const member = guild.members.cache.get(userId);
  if (member?.user.bot) return;
  const name = member?.displayName || `user-${userId}`;

  const text = await transcription.transcribePcm(pcm);
  if (!text) return;

  // Repeated short phrases from the same user in quick succession are
  // noise-gate hallucinations, not someone actually talking.
  const normalized = text.toLowerCase().split(/\s+/).join(' ');
  const prev = lastText.get(userId);
  const now = Date.now();
  if (prev && prev[0] === normalized && normalized.length <= REPEAT_MAX_CHARS
      && now - prev[1] < REPEAT_SUPPRESS_MS) {
    lastText.set(userId, [normalized, now]);
    console.log(`[voice] dropped repeated blip from ${name}: ${text}`);
    return;
  }
  lastText.set(userId, [normalized, now]);
  console.log(`[voice] [#${channel.name}] ${name}: ${text}`);

  recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: name, text });

  // Cancel words abort a pending wake response ("never mind, Max").
  const pending = pendingWake.get(channel.id);
  if (pending && !pending.cancelled && matchesAny(text, VOICE_CANCEL_WORDS)) {
    pending.cancelled = true;
    clearTimeout(pending.timer);
    pending.controller?.abort();
    pendingWake.delete(channel.id);
    console.log(`[voice] [#${channel.name}] wake response cancelled by ${name}: ${text}`);
    return;
  }

  if (matchesAny(text, VOICE_WAKE_WORDS) && (!pending || pending.cancelled)) {
    const state = { cancelled: false, controller: null, timer: null };
    state.timer = setTimeout(() => {
      if (state.cancelled) return;
      respond(channel, name, userId, state)
        .catch((err) => console.error('[voice] wake response failed:', err.message))
        .finally(() => { if (pendingWake.get(channel.id) === state) pendingWake.delete(channel.id); });
    }, WAKE_GRACE_MS);
    pendingWake.set(channel.id, state);
  }
}

async function respond(channel, speakerName, speakerId, state) {
  const now = Date.now();
  if (now - (lastWake.get(channel.id) || 0) < WAKE_COOLDOWN_MS) return;
  lastWake.set(channel.id, now);

  const guild = channel.guild;
  const systemPrompt = SYSTEM_PROMPT + VOICE_PROMPT({ channel: channel.name, speaker: speakerName });
  const transcript = formatForPrompt(guild.id, CONTEXT_TURNS);

  state.controller = new AbortController();
  let reply;
  try {
    reply = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[voice transcript of #${channel.name}]\n${transcript}` },
    ], {
      signal: state.controller.signal,
      tools: TOOL_SCHEMAS, toolHandler: runTool, maxToolRounds: MAX_TOOL_ROUNDS,
    });
  } catch (err) {
    if (state.cancelled) return; // aborted by a cancel word — expected
    if (err instanceof OpenRouterError) {
      console.warn('[voice] wake response failed:', err.message);
      return;
    }
    throw err;
  }
  if (state.cancelled || !reply) return;

  const display = tts.stripVoiceTags(reply) || reply;
  recordTurn(guild.id, { source: 'voice', channel: channel.name, speaker: 'Max', text: display });
  try {
    for (let i = 0; i < display.length; i += 1990) {
      await channel.send(display.slice(i, i + 1990));
    }
  } catch (err) {
    console.warn('[voice] posting reply failed:', err.message);
  }
  await speakInVoice(guild, display);
}

// -- TTS playback -------------------------------------------------------------

async function speakInVoice(guild, text) {
  const connection = getVoiceConnection(guild.id);
  if (!connection) return false;
  const audio = await tts.synthesize(text);
  if (!audio) return false;
  let player = players.get(guild.id);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on('error', (err) => console.error('[voice] playback error:', err.message));
    players.set(guild.id, player);
  }
  if (player.state.status !== AudioPlayerStatus.Idle) return false; // don't talk over ourselves
  connection.subscribe(player);
  player.play(createAudioResource(Readable.from(audio)));
  return true;
}

// -- owner control (join/leave a specific channel) ---------------------------

export async function joinRequestedChannel(channel) {
  manualHold.set(channel.guild.id, channel.id);
  const existing = getVoiceConnection(channel.guild.id);
  if (existing) leaveGuild(channel.guild);
  await joinChannel(channel);
}

export function leaveRequestedGuild(guild) {
  manualHold.delete(guild.id);
  leaveGuild(guild);
}
