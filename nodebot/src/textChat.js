// Persona + AI chat, text side. Voice (voice.js) calls recordTurn/
// formatForPrompt from conversation.js the same way this does — that
// shared buffer is the actual fix for text and voice not knowing about
// each other, not anything specific to this file.
import { chat, OpenRouterError } from './openrouter.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as db from './db.js';

const HISTORY_LIMIT = 40;
const MAX_TOOL_ROUNDS = 4;

function toolHandler(guildId) {
  return async (name, args) => {
    if (name.startsWith('kb_')) return runKbTool(guildId, name, args);
    return runTool(name, args);
  };
}

export async function handleMessage(client, message) {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  if (!db.getSetting(guildId, 'ai_enabled')) return;

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
  const systemPrompt = db.getSetting(guildId, 'ai_system_prompt');
  const model = db.getSetting(guildId, 'ai_model');
  try {
    const reply = await chat([
      { role: 'system', content: `${systemPrompt}\n\nRecent conversation:\n${transcript}` },
      { role: 'user', content: `${message.author.username}: ${content || '(no text)'}` },
    ], {
      model, tools: [...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS],
      toolHandler: toolHandler(guildId), maxToolRounds: MAX_TOOL_ROUNDS,
    });
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
