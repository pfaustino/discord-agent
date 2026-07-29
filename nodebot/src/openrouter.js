// Minimal OpenRouter chat-completions client. No tool-calling yet — that's
// a later layer (ported from the Python bot's tools.py/agent_tools.py once
// there's something here worth calling tools from).
import { OPENROUTER_API_KEY, OPENROUTER_MODEL } from './config.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterError extends Error {}

export async function chat(messages, { model, maxTokens = 1000, temperature = 0.7 } = {}) {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError('OPENROUTER_API_KEY is not set');
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Discord Agent',
    },
    body: JSON.stringify({
      model: model || OPENROUTER_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new OpenRouterError(`OpenRouter returned ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (content === undefined) {
    throw new OpenRouterError(`Unexpected OpenRouter response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}
