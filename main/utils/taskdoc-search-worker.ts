import { parentPort, workerData } from 'worker_threads';
import { searchTaskDocumentSuggestionsInRtws } from './taskdoc-search';

type TaskdocSuggestionWorkerPayload = {
  rootDir?: string;
  query: string;
  limit?: number;
};

type TaskdocSuggestionWorkerMessage =
  | { kind: 'ok'; suggestions: Awaited<ReturnType<typeof searchTaskDocumentSuggestionsInRtws>> }
  | { kind: 'error'; errorText: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkerPayload(value: unknown): TaskdocSuggestionWorkerPayload {
  if (!isRecord(value)) {
    throw new Error('Taskdoc suggestion worker payload must be an object');
  }
  const query = value['query'];
  if (typeof query !== 'string') {
    throw new Error('Taskdoc suggestion worker payload.query must be a string');
  }
  const rootDirRaw = value['rootDir'];
  const limitRaw = value['limit'];
  return {
    query,
    ...(typeof rootDirRaw === 'string' ? { rootDir: rootDirRaw } : {}),
    ...(typeof limitRaw === 'number' ? { limit: limitRaw } : {}),
  };
}

async function main(): Promise<void> {
  if (parentPort === null) {
    throw new Error('Taskdoc suggestion worker requires a parentPort');
  }
  try {
    const payload = parseWorkerPayload(workerData);
    const suggestions = await searchTaskDocumentSuggestionsInRtws(payload);
    const message: TaskdocSuggestionWorkerMessage = { kind: 'ok', suggestions };
    parentPort.postMessage(message);
  } catch (error: unknown) {
    const message: TaskdocSuggestionWorkerMessage = {
      kind: 'error',
      errorText: error instanceof Error ? error.message : 'Taskdoc suggestion worker failed',
    };
    parentPort.postMessage(message);
  }
}

void main();
