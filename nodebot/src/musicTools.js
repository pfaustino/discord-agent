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
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(([s]) => s);

/** Run one music tool call and return its result string (never throws).
 * Re-checks allowed() rather than trusting the caller to have filtered the
 * schemas it offered — same defence in depth as mediaTools.execute. */
export async function execute(client, message, name, args, ownerId) {
  if (!(await allowed(message, ownerId))) {
    return 'Error: music generation is limited to server admins, the server owner, or the bot owner.';
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
    return `Error: music generation failed (${err.message}).`;
  }
}
