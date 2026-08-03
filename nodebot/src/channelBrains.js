// YouTube channel caption indexing and search, via the channel-brains
// sidecar (https://github.com/Pu11en/channel-brains) — a local Python MCP
// server this bot drives through its one-shot CLI bridge instead of MCP:
// one `uvx` process per tool call, structured JSON on stdout, no persistent
// child to babysit. Ingestion survives the one-shot because create_brain
// detaches its own local worker; every other operation reads local SQLite
// and never touches YouTube.
//
// Opt-in: the whole feature hangs off CHANNEL_BRAINS_SOURCE (config.js).
// Unset means the schemas are never offered and execute() refuses, so a
// deploy without uv on the host (Railway today) never shows the model a
// tool that can't run. The sidecar keeps its own data dir; wiping it is
// the sidecar's business, not ours.
//
// Search results and transcripts are third-party caption text. The sidecar
// stamps its own untrusted-content warnings into the JSON the model sees;
// we pass them through rather than restating them.
import { execFile } from 'node:child_process';
import { CHANNEL_BRAINS_SOURCE } from './config.js';

export class ToolError extends Error {}

const RESULT_MAX_CHARS = 8000;
// First run of `uvx` resolves and builds the sidecar's environment, which
// can take a minute or two on a cold cache; after that calls are local-fast.
const TIMEOUT_MS = 180_000;

export function enabled() {
  return Boolean(CHANNEL_BRAINS_SOURCE);
}

function str(description) {
  return { type: 'string', description };
}

function int(description) {
  return { type: 'integer', description };
}

function schema(name, description, properties = {}, required = []) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  };
}

/** Translate a tool call into the sidecar CLI's argv. Pure, so tests can
 * check the mapping without spawning anything. */
export function flagsFor(name, args = {}) {
  if (name === 'index_youtube_channel') {
    const flags = ['create_brain', '--channel-url', String(args.channel_url || '')];
    if (args.max_videos) flags.push('--max-videos', String(args.max_videos));
    return flags;
  }
  if (name === 'youtube_brain_status') {
    // Snapshot only — the bridge's wait-until-terminal mode blocks until
    // ingestion ends, which a chat tool round must never do.
    const flags = ['get_brain_status'];
    if (args.brain_id) flags.push('--brain-id', String(args.brain_id));
    return flags;
  }
  if (name === 'search_youtube_captions') {
    const flags = ['search_brain', '--query', String(args.query || '')];
    if (args.brain_id) flags.push('--brain-id', String(args.brain_id));
    if (args.limit) flags.push('--limit', String(args.limit));
    return flags;
  }
  if (name === 'list_youtube_videos') {
    const flags = ['list_brain_videos', '--brain-id', String(args.brain_id || '')];
    if (args.offset) flags.push('--offset', String(args.offset));
    if (args.limit) flags.push('--limit', String(args.limit));
    return flags;
  }
  if (name === 'youtube_video_transcript') {
    const flags = [
      'get_video_transcript',
      '--brain-id', String(args.brain_id || ''),
      '--video-id', String(args.video_id || ''),
    ];
    if (args.offset) flags.push('--offset', String(args.offset));
    if (args.limit) flags.push('--limit', String(args.limit));
    return flags;
  }
  if (name === 'delete_youtube_brain') {
    // --confirm always: reaching this handler already required a deliberate
    // model call against an owner-gated schema, and the sidecar refuses to
    // delete a brain that is mid-ingestion regardless.
    return ['delete_brain', '--brain-id', String(args.brain_id || ''), '--confirm'];
  }
  throw new ToolError(`unknown channel-brains tool '${name}'`);
}

function run(flags) {
  return new Promise((resolve, reject) => {
    execFile(
      'uvx',
      ['--from', CHANNEL_BRAINS_SOURCE, 'channel-brains', ...flags],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // On failure the bridge prints {"status":"error","message":...}
          // to stderr; surface that message rather than the exit code.
          let message = '';
          try {
            message = JSON.parse(String(stderr).trim().split('\n').pop()).message;
          } catch { /* non-JSON stderr — fall through to generic text */ }
          reject(new ToolError(message || String(stderr || err.message).slice(0, 500)));
          return;
        }
        resolve(String(stdout).trim().slice(0, RESULT_MAX_CHARS));
      },
    );
  });
}

// Indexing spends bandwidth and disk and hits YouTube; deleting destroys an
// index someone may be using. Both stay owner-only while search stays open —
// same shape as agentTools' gate, checked again inside execute().
const OWNER_ONLY = new Set(['index_youtube_channel', 'delete_youtube_brain']);

const TOOLS = {
  index_youtube_channel: schema(
    'index_youtube_channel',
    'Index a YouTube channel\'s captions into a searchable local "brain". '
    + 'Returns a brain_id immediately; indexing continues in the background. '
    + 'Only index a channel the user explicitly asked for.',
    {
      channel_url: str('HTTPS YouTube channel URL: /@handle, /channel/UC..., /c/name, or /user/name'),
      max_videos: int('How many top-viewed videos to index, 1-50 (default 50)'),
    },
    ['channel_url'],
  ),
  youtube_brain_status: schema(
    'youtube_brain_status',
    'Progress snapshot for one indexed YouTube channel brain, or all of them. '
    + 'Status "ready" means indexing finished. Do not poll this repeatedly.',
    { brain_id: str('Brain to check; omit to list every brain') },
  ),
  search_youtube_captions: schema(
    'search_youtube_captions',
    'Full-text search across indexed YouTube captions. Returns ranked excerpts '
    + 'with timestamped video links. Cite the timestamp URLs when answering.',
    {
      query: str('What to search for'),
      brain_id: str('Limit the search to one brain; omit to search all'),
      limit: int('Max results, default 8'),
    },
    ['query'],
  ),
  list_youtube_videos: schema(
    'list_youtube_videos',
    'List the videos in an indexed YouTube brain and their indexing outcomes.',
    {
      brain_id: str('Brain to list'),
      offset: int('Pagination offset (default 0)'),
      limit: int('Page size (default 20)'),
    },
    ['brain_id'],
  ),
  youtube_video_transcript: schema(
    'youtube_video_transcript',
    'Read the stored caption transcript of one indexed video, in timestamped chunks.',
    {
      brain_id: str('Brain the video belongs to'),
      video_id: str('YouTube video id'),
      offset: int('Chunk offset (default 0)'),
      limit: int('Chunks per page (default 50)'),
    },
    ['brain_id', 'video_id'],
  ),
  delete_youtube_brain: schema(
    'delete_youtube_brain',
    'Permanently delete one indexed YouTube brain and all its stored captions.',
    { brain_id: str('Brain to delete') },
    ['brain_id'],
  ),
};

export const TOOL_SCHEMAS = Object.entries(TOOLS)
  .filter(([name]) => !OWNER_ONLY.has(name))
  .map(([, s]) => s);
export const OWNER_TOOL_SCHEMAS = Object.entries(TOOLS)
  .filter(([name]) => OWNER_ONLY.has(name))
  .map(([, s]) => s);

export function isChannelBrainsTool(name) {
  return name in TOOLS;
}

/** Run one sidecar tool call and return its result string (never throws). */
export async function execute(name, args, owner) {
  if (!enabled()) return 'Error: YouTube channel indexing is not enabled on this deployment.';
  if (!(name in TOOLS)) return `Error: unknown tool '${name}'.`;
  if (OWNER_ONLY.has(name) && !owner) {
    return 'Error: only the bot owner can index or delete YouTube channel brains.';
  }
  try {
    return await run(flagsFor(name, args || {}));
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    return `Error: channel-brains sidecar failed (${err.message}).`;
  }
}
