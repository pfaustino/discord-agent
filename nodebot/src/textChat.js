// Persona + AI chat, text side. Voice (voice.js) calls recordTurn/
// formatForPrompt from conversation.js the same way this does — that
// shared buffer is the actual fix for text and voice not knowing about
// each other, not anything specific to this file.
import { chat, OpenRouterError } from './openrouter.js';
import { recordTurn, formatForPrompt } from './conversation.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { KB_TOOL_SCHEMAS, runTool as runKbTool } from './knowledge.js';
import * as agentTools from './agentTools.js';
import * as documents from './documents.js';
import * as memory from './memory.js';
import { MEMBER_NOTE, OWNER_NOTE } from './persona.js';
import { isOwner } from './utils.js';
import * as db from './db.js';

const HISTORY_LIMIT = 40;
const MAX_TOOL_ROUNDS = 4;
const OWNER_MAX_TOOL_ROUNDS = 8;

function toolHandler(client, message, owner) {
  return async (name, args) => {
    if (name === 'recall_chat_log') return memory.recall(message.guild.id, args);
    if (name.startsWith('kb_')) return runKbTool(message.guild.id, name, args);
    if (owner && name in agentTools.TOOLS) return agentTools.execute(client, message, name, args);
    return runTool(name, args);
  };
}

export async function handleMessage(client, message) {
  if (message.author.bot || !message.guild) return;
  const guildId = message.guild.id;
  if (!db.getSetting(guildId, 'ai_enabled')) return;

  const owner = isOwner(message.author.id);
  const channelName = message.channel.name || 'unknown';
  const content = message.content.replace(`<@${client.user.id}>`, '').trim();

  const mentioned = message.mentions.has(client.user.id);
  if (!mentioned) {
    // Ambient: remember it happened, but don't reply. Same reasoning as
    // the Python bot — a message doesn't have to address the bot to be
    // something the bot should know about later (from voice, or from a
    // different channel).
    if (content) {
      recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content });
      memory.recordTurn(guildId, message.author.username, content, {
        source: 'text', userId: message.author.id, channel: channelName,
      });
    }
    return;
  }

  recordTurn(guildId, { source: 'text', channel: channelName, speaker: message.author.username, text: content || '(no text)' });
  memory.recordTurn(guildId, message.author.username, content, {
    source: 'text', userId: message.author.id, channel: channelName,
  });

  await message.channel.sendTyping();
  // Attachments are read automatically — no tool call — and folded into the
  // user's message before it reaches the model, same as the Python bot.
  let attachmentContext = '';
  try {
    attachmentContext = await documents.buildAttachmentContext(message);
  } catch (err) {
    console.warn('[documents] attachment context failed:', err?.message || err);
  }
  const transcript = formatForPrompt(guildId, HISTORY_LIMIT);
  const basePrompt = db.getSetting(guildId, 'ai_system_prompt');
  // The speaker's own profile card comes first, then guild-wide durable and
  // working memory — so who you're talking to isn't buried in the dump.
  const memoryBlock = memory.getContext(guildId, message.author.id);
  const systemPrompt = [basePrompt, memoryBlock, owner ? OWNER_NOTE : MEMBER_NOTE]
    .filter(Boolean).join('\n\n');
  const model = db.getSetting(guildId, 'ai_model');
  const tools = owner
    ? [...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA, ...agentTools.TOOL_SCHEMAS]
    : [...TOOL_SCHEMAS, ...KB_TOOL_SCHEMAS, memory.RECALL_TOOL_SCHEMA];
  try {
    const reply = await chat([
      { role: 'system', content: `${systemPrompt}\n\nRecent conversation:\n${transcript}` },
      {
        role: 'user',
        content: `${message.author.username}: ${content || '(no text)'}`
          + (attachmentContext ? `\n\n${attachmentContext}` : ''),
      },
    ], {
      model, tools,
      toolHandler: toolHandler(client, message, owner),
      maxToolRounds: owner ? OWNER_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
    });
    recordTurn(guildId, { source: 'text', channel: channelName, speaker: client.user.username, text: reply });
    // userId null: Max doesn't get a profile card built about himself.
    memory.recordTurn(guildId, client.user.username, reply, {
      source: 'text', userId: null, channel: channelName,
    });
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
