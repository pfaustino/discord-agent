import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, runTool } from '../src/tools.js';

test('empty query short-circuits without calling fetch', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, json: async () => ({ results: [] }) }; };
  const result = await webSearch('', fakeFetch);
  assert.equal(result, 'Empty search query.');
  assert.equal(called, false);
});

test('no results is reported plainly', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
  const result = await webSearch('nothing matches this', fakeFetch);
  assert.equal(result, 'No results found.');
});

test('formats title/url/content from Tavily response', async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.query, 'node.js');
    return {
      ok: true,
      json: async () => ({
        results: [
          { title: 'Node.js docs', url: 'https://nodejs.org', content: 'The official site' },
        ],
      }),
    };
  };
  const result = await webSearch('node.js', fakeFetch);
  assert.equal(result, 'Node.js docs\nhttps://nodejs.org\nThe official site');
});

test('caps at 5 results even when more come back', async () => {
  const results = Array.from({ length: 10 }, (_, i) => (
    { title: `Result ${i}`, url: `https://example.com/${i}`, content: 'x' }
  ));
  const fakeFetch = async () => ({ ok: true, json: async () => ({ results }) });
  const result = await webSearch('query', fakeFetch);
  assert.equal((result.match(/Result \d+/g) || []).length, 5);
  assert.ok(result.includes('Result 4'));
  assert.ok(!result.includes('Result 5'));
});

test('reports unavailable when the Tavily API errors', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'server error' });
  const result = await webSearch('query', fakeFetch);
  assert.equal(result, 'Web search is unavailable right now.');
});

test('runTool dispatches web_search and reports unknown tools', async () => {
  const unknown = await runTool('not_a_real_tool', {});
  assert.match(unknown, /^Unknown tool/);
});
