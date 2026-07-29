// OpenRouter chat-completions client, with tool-calling — ported from
// openrouter.py's agent loop (junk-verdict re-roll and the background
// spend-cap breaker are Python-side spend-control details tied to that
// bot's free-model-pool usage; deliberately not carried over here yet —
// this is the core tool loop, not a 1:1 port of every guardrail).
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from './config.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterError extends Error {}

/**
 * @param {Array} messages
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {Array} [opts.tools] OpenAI-style function-calling schemas
 * @param {(name: string, args: object) => Promise<string>} [opts.toolHandler]
 * @param {number} [opts.maxToolRounds] rounds of tool calls before the model
 *   is forced to answer without tools (default 4)
 * @param {(toolCalls: Array) => Promise<void>} [opts.onToolCalls] awaited
 *   once, right before the FIRST round of tool calls actually runs — lets a
 *   caller surface "on it, doing X" feedback for a slow multi-step action
 *   (voice.js uses this to speak a heads-up before an owner tool call
 *   executes, same as the Python bot's on_tool_calls)
 * @returns {Promise<string>} the assistant's final reply text
 */
export async function chat(messages, {
  model, maxTokens = 1000, temperature = 0.7, signal,
  tools, toolHandler, maxToolRounds = 4, onToolCalls,
} = {}) {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY is not set');
  const conversation = [...messages];
  let useTools = Boolean(tools?.length && toolHandler);

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const payload = {
      model: model || OPENROUTER_MODEL,
      messages: conversation,
      max_tokens: maxTokens,
      temperature,
    };
    if (useTools && round < maxToolRounds) payload.tools = tools;

    const resp = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Discord Agent',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      // Free-pool (and some budget) models don't support tool calling —
      // degrade to a plain reply instead of failing outright.
      if (payload.tools && [400, 404].includes(resp.status) && text.toLowerCase().includes('tool')) {
        console.warn(`[openrouter] model rejected tool use — retrying without tools (${text.slice(0, 120)})`);
        useTools = false;
        round -= 1; // retry this same round without tools
        continue;
      }
      throw new OpenRouterError(`OpenRouter returned ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message;
    if (!reply) {
      throw new OpenRouterError(`Unexpected OpenRouter response: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const toolCalls = reply.tool_calls;
    if (!(toolCalls?.length && useTools)) {
      return reply.content || '';
    }

    conversation.push(reply);
    if (onToolCalls) {
      await onToolCalls(toolCalls);
      onToolCalls = undefined; // only announce once, on the first round
    }
    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch { /* leave args empty on malformed JSON from the model */ }
      // eslint-disable-next-line no-await-in-loop
      const result = await toolHandler(call.function.name, args);
      conversation.push({ role: 'tool', tool_call_id: call.id || '', content: result });
    }
  }
  throw new OpenRouterError('Tool loop ended without a final answer');
}
