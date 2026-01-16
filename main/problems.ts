import type { WorkspaceProblem } from './shared/types/problems';
import type { ProblemsSnapshotMessage } from './shared/types/problems';
import type { WebSocketMessage } from './shared/types/wire';
import { formatUnifiedTimestamp } from './shared/utils/time';

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

let problemsVersion = 0;
const problemsById: Map<string, WorkspaceProblem> = new Map();

export function setProblemsBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
}

export function getProblemsSnapshot(): { version: number; problems: WorkspaceProblem[] } {
  return { version: problemsVersion, problems: [...problemsById.values()] };
}

export function createProblemsSnapshotMessage(): ProblemsSnapshotMessage {
  const snapshot = getProblemsSnapshot();
  return {
    type: 'problems_snapshot',
    version: snapshot.version,
    problems: snapshot.problems,
    timestamp: formatUnifiedTimestamp(new Date()),
  };
}

export function upsertProblem(problem: WorkspaceProblem): void {
  const existing = problemsById.get(problem.id);
  if (existing) {
    // If nothing changed, avoid version churn.
    const same =
      existing.kind === problem.kind &&
      existing.severity === problem.severity &&
      existing.source === problem.source &&
      existing.message === problem.message &&
      JSON.stringify(existing.detail) === JSON.stringify(problem.detail);
    if (same) {
      return;
    }
  }
  problemsById.set(problem.id, problem);
  problemsVersion++;
  broadcastSnapshot();
}

export function removeProblem(problemId: string): void {
  const existed = problemsById.delete(problemId);
  if (!existed) {
    return;
  }
  problemsVersion++;
  broadcastSnapshot();
}

export function removeProblemsByPrefix(prefix: string): void {
  let removed = 0;
  for (const id of problemsById.keys()) {
    if (!id.startsWith(prefix)) {
      continue;
    }
    problemsById.delete(id);
    removed++;
  }
  if (removed > 0) {
    problemsVersion++;
    broadcastSnapshot();
  }
}

export function reconcileProblemsByPrefix(
  prefix: string,
  desired: ReadonlyArray<WorkspaceProblem>,
): void {
  const keepIds = new Set<string>();
  for (const p of desired) {
    keepIds.add(p.id);
  }

  let changed = false;

  // Upsert desired problems (without broadcasting per insert).
  for (const p of desired) {
    const existing = problemsById.get(p.id);
    if (existing && problemsEqual(existing, p)) {
      continue;
    }
    problemsById.set(p.id, p);
    changed = true;
  }

  // Remove stale problems under prefix.
  for (const id of problemsById.keys()) {
    if (!id.startsWith(prefix)) continue;
    if (keepIds.has(id)) continue;
    problemsById.delete(id);
    changed = true;
  }

  if (changed) {
    problemsVersion++;
    broadcastSnapshot();
  }
}

function broadcastSnapshot(): void {
  if (!broadcastToClients) {
    return;
  }
  broadcastToClients(createProblemsSnapshotMessage());
}

function problemsEqual(a: WorkspaceProblem, b: WorkspaceProblem): boolean {
  return (
    a.kind === b.kind &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.message === b.message &&
    JSON.stringify(a.detail) === JSON.stringify(b.detail)
  );
}
