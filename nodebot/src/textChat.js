// Layer 2: persona + AI chat, text side. Voice (layer: TBD) will call
// recordTurn/formatForPrompt from conversation.js the same way this does —
// that shared buffer is the actual fix for text and voice not knowing
// about each other, not anything specific to this file.
import { chat, OpenRouterError } from './openrouter.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { SYSTEM_PROMPT } from './persona.js';

const HISTORY_LIMIT = 40;

export async function handleMessage(client, message) {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  const channelName = message.channel.name || 'unknown';
  const content = message.content.replace(`<@${client.user.id}>`, '').trim();

  const mentioned = message.mentions.has(client.user.id);
  if (!mentioned) {
    // Ambient: remember it happened, but don't reply. Same reasoning as
    // the Python bot — a message doesn't have to address the bot to be
    // something the bot should know about later (from voice, or from a
    // different channel).
    if (content) recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content });
    return;
  }

  recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content || '(no text)' });

  await message.channel.sendTyping();
  const transcript = formatForPrompt(guildId, HISTORY_LIMIT);
  try {
    const reply = await chat([
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nRecent conversation:\n${transcript}` },
      { role: 'user', content: `${message.author.username}: ${content || '(no text)'}` },
    ]);
    recordTurn(guildId, { source: 'text', channel: channelName, speaker: client.user.username, text: reply });
    for (let i = 0; i < reply.length; i += 1990) {
      await message.reply({ content: reply.slice(i, i + 1990), allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    if (err instanceof OpenRouterError) {
      console.error('OpenRouter error:', err.message);
      await message.reply({ content: 'AI is unavailable right now.', allowedMentions: { repliedUser: false } });
      return;
    }
    throw err;
  }
}
