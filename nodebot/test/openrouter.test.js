// chat()'s HTTP call goes through the global fetch, which we swap out for
// a fake here — these test the agent loop's control flow (when to call
// the tool handler, when to stop, how rounds are budgeted), not OpenRouter
// itself reachability, which this sandbox's egress allowlist blocks anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, OpenRouterError } from '../src/openrouter.js';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return run().finally(() => { globalThis.fetch = original; });
}

test('returns plain content when the model makes no tool calls', () => withFetch(
  async () => jsonResponse({ choices: [{ message: { content: 'hello there' } }] }),
  async () => {
    const reply = await chat([{ role: 'user', content: 'hi' }]);
    assert.equal(reply, 'hello there');
  },
));

test('runs the tool handler and feeds its result back before answering', () => {
  let call = 0;
  const seenToolCalls = [];
  return withFetch(
    async (_url, opts) => {
      call += 1;
      const body = JSON.parse(opts.body);
      if (call === 1) {
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call1', function: { name: 'web_search', arguments: '{"query":"cats"}' } }],
            },
          }],
        });
      }
      seenToolCalls.push(body.messages.at(-1));
      return jsonResponse({ choices: [{ message: { content: 'cats are great' } }] });
    },
    async () => {
      const toolHandler = async (name, args) => {
        assert.equal(name, 'web_search');
        assert.deepEqual(args, { query: 'cats' });
        return 'search result about cats';
      };
      const reply = await chat(
        [{ role: 'user', content: 'tell me about cats' }],
        { tools: [{ type: 'function', function: { name: 'web_search' } }], toolHandler },
      );
      assert.equal(reply, 'cats are great');
      assert.equal(seenToolCalls[0].role, 'tool');
      assert.equal(seenToolCalls[0].content, 'search result about cats');
    },
  );
});

test('malformed tool-call JSON args do not crash the loop', () => {
  let call = 0;
  return withFetch(
    async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            message: { tool_calls: [{ id: 'x', function: { name: 'web_search', arguments: 'not json' } }] },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: 'done' } }] });
    },
    async () => {
      const reply = await chat([{ role: 'user', content: 'hi' }], {
        tools: [{}],
        toolHandler: async (name, args) => { assert.deepEqual(args, {}); return 'ok'; },
      });
      assert.equal(reply, 'done');
    },
  );
});

test('throws OpenRouterError if the tool loop never produces a final answer', () => withFetch(
  async () => jsonResponse({
    choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'web_search', arguments: '{}' } }] } }],
  }),
  async () => {
    await assert.rejects(
      chat([{ role: 'user', content: 'hi' }], {
        tools: [{}], toolHandler: async () => 'result', maxToolRounds: 2,
      }),
      OpenRouterError,
    );
  },
));

test('throws OpenRouterError on a non-ok response', () => withFetch(
  async () => jsonResponse({ error: 'boom' }, 500),
  async () => {
    await assert.rejects(chat([{ role: 'user', content: 'hi' }]), OpenRouterError);
  },
));

test('background work defaults to the cheap utility model', () => {
  const models = [];
  return withFetch(
    async (_url, opts) => {
      models.push(JSON.parse(opts.body).model);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
    async () => {
      await chat([{ role: 'user', content: 'hi' }], { background: true });
      await chat([{ role: 'user', content: 'hi' }]);
      // config.js defaults: utility = openrouter/free, conversational =
      // anthropic/claude-3.5-haiku. Background must not use the expensive one.
      assert.equal(models[0], 'openrouter/free');
      assert.notEqual(models[1], 'openrouter/free');
    },
  );
});

test('an explicit model still wins over the background default', () => {
  const models = [];
  return withFetch(
    async (_url, opts) => {
      models.push(JSON.parse(opts.body).model);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    },
    async () => {
      await chat([{ role: 'user', content: 'hi' }], { background: true, model: 'some/model' });
      assert.equal(models[0], 'some/model');
    },
  );
});

test('re-rolls a bare junk safety verdict from the free pool', () => {
  let call = 0;
  return withFetch(
    async () => {
      call += 1;
      // One free-pool model answers everything with "user safety safe".
      if (call === 1) return jsonResponse({ choices: [{ message: { content: 'user safety safe' } }] });
      return jsonResponse({ choices: [{ message: { content: 'a real answer' } }] });
    },
    async () => {
      const reply = await chat([{ role: 'user', content: 'hi' }]);
      assert.equal(reply, 'a real answer');
      assert.equal(call, 2, 'should have re-rolled exactly once');
    },
  );
});

test('gives up re-rolling after the retry budget instead of looping forever', () => {
  let call = 0;
  return withFetch(
    async () => { call += 1; return jsonResponse({ choices: [{ message: { content: 'safe' } }] }); },
    async () => {
      const reply = await chat([{ role: 'user', content: 'hi' }]);
      assert.equal(reply, 'safe');
      assert.equal(call, 3, 'initial call plus JUNK_RETRIES re-rolls');
    },
  );
});

test('a long reply that merely mentions safety is not treated as junk', () => {
  let call = 0;
  return withFetch(
    async () => {
      call += 1;
      return jsonResponse({
        choices: [{ message: { content: 'That is safe to do, but back up your database first.' } }],
      });
    },
    async () => {
      const reply = await chat([{ role: 'user', content: 'hi' }]);
      assert.equal(reply, 'That is safe to do, but back up your database first.');
      assert.equal(call, 1, 'must not re-roll a genuine answer');
    },
  );
});

test('onToolCalls fires once, before the first round of tool calls runs', () => {
  let call = 0;
  const events = []; // records the order things happen in
  return withFetch(
    async () => {
      call += 1;
      if (call <= 2) {
        return jsonResponse({
          choices: [{
            message: { tool_calls: [{ id: `c${call}`, function: { name: 'web_search', arguments: '{}' } }] },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: 'done' } }] });
    },
    async () => {
      const reply = await chat([{ role: 'user', content: 'hi' }], {
        tools: [{}],
        toolHandler: async () => { events.push('tool'); return 'ok'; },
        onToolCalls: async (toolCalls) => {
          events.push('announce');
          assert.equal(toolCalls.length, 1);
        },
        maxToolRounds: 4,
      });
      assert.equal(reply, 'done');
      // announced once, before the FIRST tool ran, and never again on round 2
      assert.deepEqual(events, ['announce', 'tool', 'tool']);
    },
  );
});
