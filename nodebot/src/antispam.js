// Cross-channel spam ban: a member posting the same message (or attachment
// burst) into several channels within a short window is almost always a
// compromised account being used to blast the whole server, not a member
// misbehaving on purpose. Auto-ban them (deleteMessageSeconds purges their
// recent messages guild-wide, not just the triggering channel) so the
// damage stops immediately; they can ask the owner for /unban once their
// account is secured.
import { PermissionFlagsBits } from 'discord.js';
import { logAction } from './utils.js';
import * as db from './db.js';

const DEFAULT_THRESHOLD = 4;
const DEFAULT_WINDOW_SECONDS = 20;
const DEFAULT_DELETE_SECONDS = 3600;

// guildId:userId -> { key, firstSeen, entries: Map<channelId, timestamp> }
const trackers = new Map();
// guildId:userId currently mid-ban, so a burst of messages arriving while
// the ban() call is in flight can't trigger a second ban attempt.
const banning = new Set();

function normalize(content, hasAttachments) {
  const text = (content || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text && !hasAttachments) return ''; // nothing to correlate on
  return hasAttachments ? `${text}|att` : text;
}

/**
 * Record one message toward a member's cross-channel spam tally and report
 * whether it just crossed the threshold. Pure state-tracking, no Discord
 * calls, so it's cheap to unit test.
 *
 * @returns {{triggered: boolean, channelCount: number}|null} null if the
 *   message has nothing to correlate on (no text, no attachments).
 */
export function recordAndCheck(guildId, userId, channelId, content, hasAttachments, {
  channelThreshold = DEFAULT_THRESHOLD,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
} = {}, nowMs = Date.now()) {
  const key = normalize(content, hasAttachments);
  if (!key) return null;

  const trackerKey = `${guildId}:${userId}`;
  const windowMs = windowSeconds * 1000;
  let tracker = trackers.get(trackerKey);
  if (!tracker || tracker.key !== key || nowMs - tracker.firstSeen > windowMs) {
    tracker = { key, firstSeen: nowMs, entries: new Map() };
  }
  for (const [ch, ts] of tracker.entries) {
    if (nowMs - ts > windowMs) tracker.entries.delete(ch);
  }
  tracker.entries.set(channelId, nowMs);

  if (tracker.entries.size >= channelThreshold) {
    trackers.delete(trackerKey); // one trigger per burst, not one per message
    return { triggered: true, channelCount: tracker.entries.size };
  }
  trackers.set(trackerKey, tracker);
  return { triggered: false, channelCount: tracker.entries.size };
}

export async function checkMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (!db.getSetting(message.guild.id, 'antispam_enabled')) return;
  if (!message.member) return; // already gone — nothing to ban
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return; // staff exempt

  const guildId = message.guild.id;
  const channelThreshold = Number(db.getSetting(guildId, 'antispam_channel_threshold')) || DEFAULT_THRESHOLD;
  const windowSeconds = Number(db.getSetting(guildId, 'antispam_window_seconds')) || DEFAULT_WINDOW_SECONDS;

  const result = recordAndCheck(
    guildId, message.author.id, message.channel.id, message.content,
    message.attachments?.size > 0, { channelThreshold, windowSeconds },
  );
  if (!result?.triggered) return;

  const banKey = `${guildId}:${message.author.id}`;
  if (banning.has(banKey)) return;
  banning.add(banKey);

  try {
    const reason = `Cross-channel spam: the same message hit ${result.channelCount} channels `
      + `within ${windowSeconds}s (likely a compromised account)`;
    if (!message.member.bannable) {
      console.warn(`[antispam] flagged ${message.author.tag} but lack permission to ban them`);
      await logAction(message.guild, 'antispam_flag', 'AntiSpam', message.author,
        `${reason} — ban failed, insufficient permissions`);
      return;
    }
    const deleteSeconds = Number(db.getSetting(guildId, 'antispam_delete_seconds')) || DEFAULT_DELETE_SECONDS;
    await message.member.ban({ reason, deleteMessageSeconds: deleteSeconds });
    await logAction(message.guild, 'antispam_ban', 'AntiSpam', message.author, reason);
  } catch (err) {
    console.warn('[antispam] ban failed:', err.message);
  } finally {
    banning.delete(banKey);
  }
}

/** Test seam: drop all in-process state. */
export function _resetForTests() {
  trackers.clear();
  banning.clear();
}
