// Music generation, exposed to the AI as a tool. music.js does the actual
// OpenRouter/Lyria call; this file decides who is allowed to spend money on
// it and what the model is told once the file is in the channel.
//
// Unlike mediaTools.js's images/video (a per-guild media_access setting that
// a server can open up to 'everyone'), access here is fixed: only someone
// who already outranks ordinary members in this server may ask for a song —
// Discord Administrator (which the server owner always has), a role listed
// in dashboard_admin_roles, or the bot owner. That's deliberately the same
// 'admin' tier the dashboard itself uses (web/roles.js), reused rather than
// re-invented, so "who counts as an admin" can't drift into two different
// answers depending on which surface is asking.
import { PermissionsBitField } from 'discord.js';
import * as db from './db.js';
import * as music from './music.js';
import { resolveLevel, memberFacts, levelAtLeast } from './web/roles.js';
import { OWNER_ID } from './config.js';
import { uploadLimit, tooLarge, postedNote } from './mediaTools.js';

export class ToolError extends Error {}

function str(description) {
  return { type: 'string', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

/** May this message's author ask for a song? True for the bot owner and for
 * anyone the dashboard would already call 'admin' in this server — which
 * includes the server owner, since Discord grants owners Administrator
 * implicitly. ownerId is an injectable override for testing, same as
 * mediaTools.allowed's. */
export async function allowed(message, ownerId = OWNER_ID) {
  const { guild } = message;
  let member = message.member || guild.members.cache.get(String(message.author.id));
  if (!member) {
    try {
      member = await guild.members.fetch(String(message.author.id));
    } catch {
      return false; // not a member of this guild
    }
  }
  const level = resolveLevel({
    ...memberFacts(member, PermissionsBitField),
    ownerId,
    adminRoles: db.getSetting(guild.id, 'dashboard_admin_roles') || [],
    modRoles: db.getSetting(guild.id, 'dashboard_mod_roles') || [],
  });
  return levelAtLeast(level, 'admin');
}

// -- voice playback bridge ---------------------------------------------------
// The actual AudioPlayer/connection machinery lives in voice.js, which
// already imports this file statically (its tool dispatch runs
// musicTools.execute) — so this file can't import voice.js back at load
// time without a cycle. Resolved lazily instead, the same way voice.js
// itself lazily reaches for proactive.js — and swappable here for tests,
// which stand in a fake rather than driving a real @discordjs/voice
// connection.
let voiceModule = null;
async function getVoice() {
  if (!voiceModule) voiceModule = await import('./voice.js');
  return voiceModule;
}
/** Test seam: point playback calls at a fake instead of the real voice.js. */
export function _setVoiceModuleForTests(mod) { voiceModule = mod; }

/** Test seam: drop the "song I just made" cache — it's keyed by guild id and
 * every test's fakeMessage shares the same one, so without this a save_song
 * or play_song left pending by an earlier test would leak into the next. */
export function _resetForTests() { lastGenerated.clear(); }

// -- "the song I just made" ---------------------------------------------------
// A generated clip isn't saved to the library automatically — that's a
// decision someone makes after actually hearing it. This is the bridge
// between the two: generateSong stashes the raw clip here, and save_song /
// play_song (called with no song named) reach for it. Keyed by guild only,
// same as everything else music-related here. The TTL keeps a save_song
// called long after the fact from silently persisting a stale, forgotten
// take.
const LAST_SONG_TTL_MS = 15 * 60 * 1000;
const lastGenerated = new Map(); // guildId -> { data, mediaType, prompt, length, costUsd, at }

function pendingSong(guildId) {
  const entry = lastGenerated.get(guildId);
  if (!entry || Date.now() - entry.at > LAST_SONG_TTL_MS) return null;
  return entry;
}

// -- handlers -----------------------------------------------------------------

async function generateSong(client, message, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new ToolError('generate_music needs a prompt.');
  const length = args.length === 'full' ? 'full' : 'short';

  let notice = null;
  try {
    notice = await message.channel.send(length === 'full'
      ? 'Writing a song — this can take a minute or two.'
      : 'Writing a quick track — one sec.');
  } catch (err) {
    console.warn('[musicTools] could not post the music notice:', err.message);
  }

  try {
    let clip;
    try {
      clip = await music.generateMusic(prompt, { length });
    } catch (err) {
      if (err instanceof music.MusicError) throw new ToolError(err.message);
      throw err;
    }

    lastGenerated.set(message.guild.id, {
      data: clip.data, mediaType: clip.mediaType, prompt, length, costUsd: clip.costUsd, at: Date.now(),
    });

    const limit = uploadLimit(message.guild);
    if (clip.data.length > limit) {
      return tooLarge(clip.data.length, limit, 'ask for a shorter track — a clip instead of a full song');
    }
    await message.channel.send({ files: [{ attachment: clip.data, name: 'generated_song.mp3' }] });
    const cost = clip.costUsd
      ? ` It cost $${clip.costUsd.toFixed(4)} to make (you may mention this if asked).`
      : '';
    return `${postedNote(1, 'track')}${cost}`;
  } finally {
    if (notice) {
      await notice.delete().catch(() => { /* already gone, or no permission */ });
    }
  }
}

// -- song library handlers ----------------------------------------------------

function libraryLine(row, i) {
  const kind = row.length === 'full' ? 'full song' : 'clip';
  return `${i + 1}. ${row.title} (${kind})`;
}

async function saveSong(client, message, args) {
  const title = String(args.title || '').trim();
  if (!title) throw new ToolError('save_song needs a title for the song.');
  const pending = pendingSong(message.guild.id);
  if (!pending) {
    throw new ToolError('there is no recently generated song to save — call generate_music first, '
      + 'then save_song right after, while it is still fresh.');
  }
  const count = db.countSongs(message.guild.id);
  if (count >= db.SONG_LIBRARY_CAP) {
    const titles = db.listSongs(message.guild.id).map((r) => r.title).join(', ');
    throw new ToolError(`the song library is full (${db.SONG_LIBRARY_CAP}/${db.SONG_LIBRARY_CAP}): ${titles}. `
      + 'Ask the user which one to remove, call delete_song with it, then call save_song again.');
  }
  db.addSong(message.guild.id, {
    title, prompt: pending.prompt, data: pending.data, mediaType: pending.mediaType,
    length: pending.length, costUsd: pending.costUsd, createdBy: message.author.id,
  });
  lastGenerated.delete(message.guild.id); // saved — a second save_song shouldn't silently duplicate it
  return `Saved "${title}" to the song library (${count + 1}/${db.SONG_LIBRARY_CAP}).`;
}

async function listSongsHandler(client, message) {
  const rows = db.listSongs(message.guild.id);
  if (!rows.length) return 'The song library is empty — nothing has been saved yet.';
  return `Song library (${rows.length}/${db.SONG_LIBRARY_CAP}):\n${rows.map(libraryLine).join('\n')}`;
}

async function deleteSongHandler(client, message, args) {
  const query = String(args.song || '').trim();
  if (!query) throw new ToolError('delete_song needs the title (or list number) of the song to remove.');
  const row = db.findSong(message.guild.id, query);
  if (!row) {
    throw new ToolError(`no single saved song matches "${query}" — use list_songs to see the exact titles.`);
  }
  db.deleteSong(message.guild.id, row.id);
  return `Deleted "${row.title}" from the song library.`;
}

async function playSongHandler(client, message, args) {
  const query = String(args.song || '').trim();
  let song;
  if (!query) {
    const pending = pendingSong(message.guild.id);
    if (!pending) {
      throw new ToolError('no song was named and nothing was generated recently — name a saved song, '
        + 'or call generate_music first.');
    }
    song = { title: 'the song I just made', data: pending.data, mediaType: pending.mediaType };
  } else {
    const row = db.findSong(message.guild.id, query);
    if (!row) {
      throw new ToolError(`no single saved song matches "${query}" — use list_songs to see the exact titles.`);
    }
    song = db.getSongData(message.guild.id, row.id);
  }
  const voice = await getVoice();
  const started = await voice.playInVoice(message.guild, [song]);
  if (!started) {
    throw new ToolError("I'm not in a voice channel here, or something is already playing — "
      + 'say stop_music first if something is already going.');
  }
  return `Now playing "${song.title}" in voice.`;
}

async function playPlaylistHandler(client, message) {
  const rows = db.listSongs(message.guild.id);
  if (!rows.length) throw new ToolError('the song library is empty — save a song first with save_song.');
  const songs = rows.map((r) => db.getSongData(message.guild.id, r.id)).filter(Boolean);
  const voice = await getVoice();
  const started = await voice.playInVoice(message.guild, songs);
  if (!started) {
    throw new ToolError("I'm not in a voice channel here, or something is already playing — "
      + 'say stop_music first if something is already going.');
  }
  return `Started the playlist — ${songs.length} song(s), starting with "${songs[0].title}".`;
}

async function stopMusicHandler(client, message) {
  const voice = await getVoice();
  const stopped = voice.stopMusic(message.guild);
  return stopped ? 'Stopped the music.' : 'Nothing was playing.';
}

// -- registry ---------------------------------------------------------------

export const TOOLS = {
  generate_music: [schema('generate_music',
    'Compose a piece of music and post it in the channel, once you actually know what to make. '
    + 'Do NOT call this the first time someone asks for a song — ask 2-4 quick questions first '
    + '(genre/style, mood or energy, key instruments or whether it should have vocals and lyrics, '
    + 'and whether they want a short ~30-second clip to try an idea or a longer full song) unless '
    + 'they already gave you enough of that unprompted. Only call this once you have a real feel '
    + "for what they want. Write the actual prompt yourself from what they told you — genre, "
    + 'mood, instruments, tempo, structure, and any lyrics — rather than forwarding their words '
    + 'verbatim.',
    {
      prompt: str('The full music prompt: genre/style, mood, instruments, tempo, structure '
        + '(intro/verse/chorus/etc, mainly useful for a full song), and lyrics if it should have '
        + "vocals. Written specifically from what the user told you, not their wording verbatim."),
      length: str("'short' for a ~30 second clip (fast, cheap — good for trying an idea), or "
        + "'full' for a complete structured song. Default 'short' unless they asked for a full song."),
    }, ['prompt']), generateSong],
  save_song: [schema('save_song',
    'Save the most recently generated song to the persistent song library (holds up to '
    + `${db.SONG_LIBRARY_CAP} songs) so it can be played again later without regenerating it. Only `
    + 'call this after generate_music, and only if the user actually said they like the result and '
    + 'want to keep it — never save automatically. If the library is already full, this tells you '
    + 'the current titles so you can ask which one to remove first.',
    { title: str('A short, memorable title for the song.') }, ['title']), saveSong],
  list_songs: [schema('list_songs',
    'List the songs currently saved in the persistent song library.', {}, []), listSongsHandler],
  delete_song: [schema('delete_song',
    'Remove a song from the persistent song library, by title (or its number from list_songs). Use '
    + 'this when the user wants an old song gone, or needs to make room for a new one — the library '
    + `holds at most ${db.SONG_LIBRARY_CAP} songs.`,
    { song: str('The title (or list number) of the song to remove.') }, ['song']), deleteSongHandler],
  play_song: [schema('play_song',
    "Play a song through the bot's current voice channel. Name a saved song from the library by "
    + 'title, or leave it blank to play whatever generate_music just made, even if it has not been '
    + "saved yet — that's how to let someone hear a fresh take before deciding whether to keep it. "
    + 'Requires the bot to already be sitting in a voice channel. If something is already playing, '
    + 'call stop_music first.',
    { song: str('The title of a saved song to play. Leave blank for the most recently generated song.') }, []),
    playSongHandler],
  play_playlist: [schema('play_playlist',
    'Play every song in the persistent song library, back to back, through the voice channel the '
    + "bot is currently in. Use this when someone asks for 'the playlist' or wants music playing "
    + 'rather than one specific track. Call stop_music first if something is already playing.',
    {}, []), playPlaylistHandler],
  stop_music: [schema('stop_music',
    'Stop whatever song or playlist is currently playing in voice and go back to plain listening. '
    + 'Use this any time someone asks to stop the music, pause it, or wants to talk instead.',
    {}, []), stopMusicHandler],
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

/** Run one music tool call and return its result string (never throws).
 * Re-checks allowed() rather than trusting the caller to have filtered the
 * schemas it offered — same defence in depth as mediaTools.execute. */
export async function execute(client, message, name, args, ownerId) {
  if (!(await allowed(message, ownerId))) {
    return 'Error: music and the song library are limited to server admins, the server owner, or the bot owner.';
  }
  const entry = TOOLS[name];
  if (!entry) return `Error: unknown tool '${name}'.`;
  try {
    return await entry[1](client, message, args || {});
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    if (err instanceof music.MusicError) return `Error: ${err.message}`;
    if (err.code === 50013 || err.status === 403) {
      return "Error: I don't have permission to attach files in this channel.";
    }
    if (err.code === 40005) return 'Error: Discord rejected the upload as too large.';
    if (err.name === 'DiscordAPIError') return `Error: Discord API error: ${err.message}`;
    return `Error: ${name} failed (${err.message}).`;
  }
}
