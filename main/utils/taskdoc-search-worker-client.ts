import fsSync from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { SearchTaskDocumentSuggestionsResult } from './taskdoc-search';

const requireFn = createRequire(__filename);
const TASKDOC_SUGGESTION_WORKER_TIMEOUT_MS = 10_000;
const TASKDOC_SUGGESTION_MAX_WORKERS = 2;
const TASKDOC_SUGGESTION_MAX_PENDING_WORKERS = 8;
const TASKDOC_SUGGESTION_CACHE_TTL_MS = 3_000;
const TASKDOC_SUGGESTION_CACHE_MAX_ENTRIES = 64;
let activeTaskdocSuggestionWorkers = 0;
const pendingTaskdocSuggestionWorkerSlots: Array<() => void> = [];
const taskdocSuggestionCache = new Map<
  string,
  Readonly<{ expiresAtMs: number; result: SearchTaskDocumentSuggestionsResult }>
>();
const taskdocSuggestionInFlightByCacheKey = new Map<
  string,
  Promise<SearchTaskDocumentSuggestionsResult>
>();

export type TaskdocSuggestionWorkerPayload = {
  rootDir?: string;
  query: string;
  limit?: number;
};

type TaskdocSuggestionWorkerOptions = {
  signal?: AbortSignal;
};

type TaskdocSuggestionWorkerMessage =
  | { kind: 'ok'; suggestions: SearchTaskDocumentSuggestionsResult }
  | { kind: 'error'; errorText: string };

type TaskdocSuggestionWorkerEntrypointResolution =
  | Readonly<{ ok: true; kind: 'compiled_js'; scriptAbs: string }>
  | Readonly<{ ok: true; kind: 'tsx_cjs_bridge'; scriptAbs: string; tsxCjsRegisterAbs: string }>
  | Readonly<{ ok: false; errorText: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTaskdocSuggestionLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
}

function normalizeTaskdocSuggestionQueryKey(query: string): string {
  const normalized = query.trim().toLowerCase();
  return normalized.endsWith('.tsk') ? normalized.slice(0, -4) : normalized;
}

export function buildTaskDocumentSuggestionRequestKey(
  payload: TaskdocSuggestionWorkerPayload,
): string {
  return normalizeTaskdocSuggestionQueryKey(payload.query);
}

function buildTaskDocumentSuggestionCacheKey(payload: TaskdocSuggestionWorkerPayload): string {
  return [
    path.resolve(payload.rootDir ?? '.'),
    String(normalizeTaskdocSuggestionLimit(payload.limit)),
    buildTaskDocumentSuggestionRequestKey(payload),
  ].join('\u0000');
}

function readTaskDocumentSuggestionCache(
  cacheKey: string,
): SearchTaskDocumentSuggestionsResult | undefined {
  const cached = taskdocSuggestionCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAtMs <= Date.now()) {
    taskdocSuggestionCache.delete(cacheKey);
    return undefined;
  }
  return cached.result;
}

function writeTaskDocumentSuggestionCache(
  cacheKey: string,
  result: SearchTaskDocumentSuggestionsResult,
): void {
  if (result.kind !== 'ok') return;
  const now = Date.now();
  for (const [key, cached] of taskdocSuggestionCache) {
    if (cached.expiresAtMs <= now) taskdocSuggestionCache.delete(key);
  }
  taskdocSuggestionCache.delete(cacheKey);
  taskdocSuggestionCache.set(cacheKey, {
    expiresAtMs: now + TASKDOC_SUGGESTION_CACHE_TTL_MS,
    result,
  });
  while (taskdocSuggestionCache.size > TASKDOC_SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestKey = taskdocSuggestionCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    taskdocSuggestionCache.delete(oldestKey);
  }
}

async function waitForTaskDocumentSuggestionResult(
  promise: Promise<SearchTaskDocumentSuggestionsResult>,
  signal: AbortSignal | undefined,
): Promise<SearchTaskDocumentSuggestionsResult> {
  if (!signal) return await promise;
  if (signal.aborted) {
    return { kind: 'error', errorText: 'Taskdoc suggestion request aborted' };
  }
  return await new Promise<SearchTaskDocumentSuggestionsResult>((resolve) => {
    let settled = false;
    const settle = (result: SearchTaskDocumentSuggestionsResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortWait);
      resolve(result);
    };
    const abortWait = (): void => {
      settle({ kind: 'error', errorText: 'Taskdoc suggestion request aborted' });
    };
    signal.addEventListener('abort', abortWait, { once: true });
    promise.then(settle, (error: unknown) => {
      settle({
        kind: 'error',
        errorText: error instanceof Error ? error.message : 'Taskdoc suggestion worker failed',
      });
    });
  });
}

function parseWorkerMessage(value: unknown): TaskdocSuggestionWorkerMessage {
  if (!isRecord(value)) throw new Error('Taskdoc suggestion worker returned non-object message');
  const kind = value['kind'];
  switch (kind) {
    case 'ok': {
      const suggestionsRaw = value['suggestions'];
      if (!isRecord(suggestionsRaw)) {
        throw new Error('Taskdoc suggestion worker ok message missing suggestions');
      }
      if (suggestionsRaw['kind'] === 'ok') {
        const listRaw = suggestionsRaw['suggestions'];
        if (!Array.isArray(listRaw)) {
          throw new Error('Taskdoc suggestion worker ok result missing suggestions list');
        }
        return {
          kind: 'ok',
          suggestions: {
            kind: 'ok',
            suggestions: listRaw.map((item) => {
              if (!isRecord(item)) {
                throw new Error('Taskdoc suggestion worker returned invalid suggestion item');
              }
              const pathRaw = item['path'];
              const relativePath = item['relativePath'];
              const name = item['name'];
              if (
                typeof pathRaw !== 'string' ||
                typeof relativePath !== 'string' ||
                typeof name !== 'string'
              ) {
                throw new Error('Taskdoc suggestion worker returned malformed suggestion item');
              }
              return { path: pathRaw, relativePath, name };
            }),
          },
        };
      }
      if (suggestionsRaw['kind'] === 'error') {
        const errorText = suggestionsRaw['errorText'];
        if (typeof errorText !== 'string') {
          throw new Error('Taskdoc suggestion worker error result missing errorText');
        }
        return { kind: 'ok', suggestions: { kind: 'error', errorText } };
      }
      throw new Error('Taskdoc suggestion worker returned unknown suggestions kind');
    }
    case 'error': {
      const errorText = value['errorText'];
      if (typeof errorText !== 'string') {
        throw new Error('Taskdoc suggestion worker error message missing errorText');
      }
      return { kind: 'error', errorText };
    }
    default:
      throw new Error(`Taskdoc suggestion worker returned unknown message kind: ${String(kind)}`);
  }
}

function resolveTaskdocSuggestionWorkerEntrypointAbs(): TaskdocSuggestionWorkerEntrypointResolution {
  const distCandidate = path.resolve(__dirname, 'taskdoc-search-worker.js');
  if (fsSync.existsSync(distCandidate)) {
    return { ok: true, kind: 'compiled_js', scriptAbs: distCandidate };
  }
  const tsCandidate = path.resolve(__dirname, 'taskdoc-search-worker.ts');
  if (fsSync.existsSync(tsCandidate)) {
    const tsxCjsRegisterAbs = requireFn.resolve('tsx/cjs');
    return { ok: true, kind: 'tsx_cjs_bridge', scriptAbs: tsCandidate, tsxCjsRegisterAbs };
  }
  return {
    ok: false,
    errorText: `Cannot find taskdoc suggestion worker entrypoint at ${distCandidate} or ${tsCandidate}`,
  };
}

async function acquireTaskdocSuggestionWorkerSlot(): Promise<void> {
  if (activeTaskdocSuggestionWorkers < TASKDOC_SUGGESTION_MAX_WORKERS) {
    activeTaskdocSuggestionWorkers += 1;
    return;
  }
  if (pendingTaskdocSuggestionWorkerSlots.length >= TASKDOC_SUGGESTION_MAX_PENDING_WORKERS) {
    throw new Error('Taskdoc suggestion worker queue is full');
  }
  await new Promise<void>((resolve) => {
    const grantSlot = (): void => {
      activeTaskdocSuggestionWorkers += 1;
      resolve();
    };
    pendingTaskdocSuggestionWorkerSlots.push(grantSlot);
  });
}

function releaseTaskdocSuggestionWorkerSlot(): void {
  activeTaskdocSuggestionWorkers = Math.max(0, activeTaskdocSuggestionWorkers - 1);
  const next = pendingTaskdocSuggestionWorkerSlots.shift();
  if (next) {
    next();
    return;
  }
}

async function runTaskDocumentSuggestionsWorker(
  payload: TaskdocSuggestionWorkerPayload,
): Promise<SearchTaskDocumentSuggestionsResult> {
  const entry = resolveTaskdocSuggestionWorkerEntrypointAbs();
  if (!entry.ok) return { kind: 'error', errorText: entry.errorText };

  let acquiredWorkerSlot = false;
  try {
    await acquireTaskdocSuggestionWorkerSlot();
    acquiredWorkerSlot = true;
    const worker =
      entry.kind === 'compiled_js'
        ? new Worker(entry.scriptAbs, { workerData: payload })
        : new Worker(
            'const { workerData } = require("worker_threads"); require(workerData.tsxCjsRegisterAbs); require(workerData.scriptAbs);',
            {
              eval: true,
              workerData: {
                ...payload,
                scriptAbs: entry.scriptAbs,
                tsxCjsRegisterAbs: entry.tsxCjsRegisterAbs,
              },
            },
          );
    return await new Promise<SearchTaskDocumentSuggestionsResult>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        releaseTaskdocSuggestionWorkerSlot();
        void worker.terminate();
        resolve({ kind: 'error', errorText: 'Taskdoc suggestion worker timed out' });
      }, TASKDOC_SUGGESTION_WORKER_TIMEOUT_MS);

      const settle = (result: SearchTaskDocumentSuggestionsResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        releaseTaskdocSuggestionWorkerSlot();
        void worker.terminate();
        resolve(result);
      };

      worker.once('message', (raw: unknown) => {
        try {
          const message = parseWorkerMessage(raw);
          if (message.kind === 'ok') {
            settle(message.suggestions);
            return;
          }
          settle({ kind: 'error', errorText: message.errorText });
        } catch (error: unknown) {
          settle({
            kind: 'error',
            errorText: error instanceof Error ? error.message : 'Invalid taskdoc worker response',
          });
        }
      });

      worker.once('error', (error: Error) => {
        settle({ kind: 'error', errorText: error.message });
      });

      worker.once('exit', (code: number) => {
        if (settled) return;
        settle({ kind: 'error', errorText: `Taskdoc suggestion worker exited with code ${code}` });
      });
    });
  } catch (error: unknown) {
    if (acquiredWorkerSlot) releaseTaskdocSuggestionWorkerSlot();
    return {
      kind: 'error',
      errorText: error instanceof Error ? error.message : 'Failed to start taskdoc worker',
    };
  }
}

export async function searchTaskDocumentSuggestionsInWorker(
  payload: TaskdocSuggestionWorkerPayload,
  options: TaskdocSuggestionWorkerOptions = {},
): Promise<SearchTaskDocumentSuggestionsResult> {
  if (options.signal?.aborted) {
    return { kind: 'error', errorText: 'Taskdoc suggestion request aborted' };
  }

  const cacheKey = buildTaskDocumentSuggestionCacheKey(payload);
  const cached = readTaskDocumentSuggestionCache(cacheKey);
  if (cached) return cached;

  let inFlight = taskdocSuggestionInFlightByCacheKey.get(cacheKey);
  if (!inFlight) {
    inFlight = runTaskDocumentSuggestionsWorker(payload)
      .then((result) => {
        writeTaskDocumentSuggestionCache(cacheKey, result);
        return result;
      })
      .finally(() => {
        taskdocSuggestionInFlightByCacheKey.delete(cacheKey);
      });
    taskdocSuggestionInFlightByCacheKey.set(cacheKey, inFlight);
  }

  return await waitForTaskDocumentSuggestionResult(inFlight, options.signal);
}
