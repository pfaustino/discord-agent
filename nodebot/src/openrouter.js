// OpenRouter chat-completions client, with tool-calling — ported from
// openrouter.py's agent loop, including the background spend-cap breaker
// and the free-pool junk-verdict re-roll.
import {
  OPENROUTER_API_KEY, OPENROUTER_MODEL,
  OPENROUTER_UTILITY_MODEL, OPENROUTER_BG_HOURLY_CAP,
} from './config.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterError extends Error {}

// Timestamps of background calls in the last hour, for the spend breaker.
const bgCalls = [];

/** Throws once background calls exceed the hourly cap. */
function bgBudgetCheck() {
  const cap = OPENROUTER_BG_HOURLY_CAP;
  if (cap <= 0) return;
  const now = Date.now();
  while (bgCalls.length && now - bgCalls[0] > 3600_000) bgCalls.shift();
  if (bgCalls.length >= cap) {
    throw new OpenRouterError(`background call budget exhausted (${cap}/hour) — skipping`);
  }
  bgCalls.push(now);
}

// One model in the free pool answers everything with a bare safety verdict
// ("user safety safe"). Detect that and re-roll so the free router picks a
// different model, rather than passing the junk through as Max's reply.
const JUNK_VERDICT_RE = /^\W*(user\s*safety\W*)?(safe|unsafe)\W*$/i;
const JUNK_RETRIES = 2;

function isJunkVerdict(content) {
  const text = (content || '').trim();
  return text.length < 40 && JUNK_VERDICT_RE.test(text);
}

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
 * @param {boolean} [opts.background] mark this as background work: it counts
 *   against the hourly spend cap, and defaults to the cheap utility model
 *   instead of the conversational one
 * @returns {Promise<string>} the assistant's final reply text
 */
export async function chat(messages, {
  model, maxTokens = 1000, temperature = 0.7, signal,
  tools, toolHandler, maxToolRounds = 4, onToolCalls, background = false,
} = {}) {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY is not set');
  if (background) bgBudgetCheck();
  const conversation = [...messages];
  let useTools = Boolean(tools?.length && toolHandler);
  let junkRetries = 0;

  // The extra JUNK_RETRIES iterations are re-rolls, not tool rounds — a
  // junk verdict must not eat the model's budget for actually using tools.
  for (let round = 0; round <= maxToolRounds + JUNK_RETRIES; round += 1) {
    const payload = {
      model: model || (background ? OPENROUTER_UTILITY_MODEL : OPENROUTER_MODEL),
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

    const usage = data.usage || {};
    console.log(`[llm] ${payload.model}${background ? ' [bg]' : ''} `
      + `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}`);

    const toolCalls = reply.tool_calls;
    if (!(toolCalls?.length && useTools)) {
      const content = reply.content || '';
      if (isJunkVerdict(content) && junkRetries < JUNK_RETRIES) {
        junkRetries += 1;
        console.log(`[openrouter] junk safety verdict from ${payload.model} — re-rolling (${junkRetries}/${JUNK_RETRIES})`);
        continue;
      }
      return content;
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
