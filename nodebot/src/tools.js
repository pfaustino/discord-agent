// Tools the AI can call. Ported from the Python bot's tools.py, starting
// with web_search — GitHub/sandbox/moderation/memory-recall/knowledge-base
// tools follow once their own persistence/identity pieces exist here.
import { TAVILY_API_KEY } from './config.js';

const SEARCH_RESULTS = 5;
const RESULT_MAX_CHARS = 8000;

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: (
        'Search the web with Tavily. Use this for current events, '
        + "documentation, or anything you don't know or might be out of date on."
      ),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
      },
    },
  },
];

export async function runTool(name, args) {
  try {
    if (name === 'web_search') return await webSearch(String(args.query || ''));
    return `Unknown tool: ${name}`;
  } catch (err) {
    console.warn(`[tools] ${name} failed:`, err.message);
    return `Tool ${name} failed: ${err.message}`;
  }
}

function formatResults(results) {
  if (!results?.length) return 'No results found.';
  const text = results
    .slice(0, SEARCH_RESULTS)
    .map((r) => `${r.title || ''}\n${r.url || ''}\n${r.content || ''}`)
    .join('\n\n');
  return text.slice(0, RESULT_MAX_CHARS);
}

/** fetchFn is injectable for testing. Real call sites never pass it. */
export async function webSearch(query, fetchFn = fetch) {
  if (!query) return 'Empty search query.';
  if (!TAVILY_API_KEY) {
    console.error('[tools] web search is unavailable — TAVILY_API_KEY is not set '
      + '(free tier at https://tavily.com).');
    return 'Web search is unavailable right now.';
  }

  try {
    return formatResults(await tavilySearch(query, fetchFn));
  } catch (err) {
    console.warn('[tools] Tavily search failed:', err.message);
    return 'Web search is unavailable right now.';
  }
}

async function tavilySearch(query, fetchFn) {
  const resp = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: SEARCH_RESULTS,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Tavily API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
  }));
}
