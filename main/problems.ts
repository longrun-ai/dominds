import type {
  ProblemsSnapshotMessage,
  WorkspaceProblem,
  WorkspaceProblemRecord,
} from '@longrun-ai/kernel/types/problems';
import type { WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

let problemsVersion = 0;
const problemsById: Map<string, WorkspaceProblemRecord> = new Map();

export type ProblemFilter = Readonly<{
  source?: WorkspaceProblem['source'];
  path?: string;
  problemId?: string;
  resolved?: boolean;
}>;

export function setProblemsBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
}

export function getProblemsSnapshot(): { version: number; problems: WorkspaceProblemRecord[] } {
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
  const next = toActiveProblemRecord(problem, existing);
  if (existing && problemRecordsEqual(existing, next)) {
    return;
  }
  problemsById.set(problem.id, next);
  problemsVersion++;
  broadcastSnapshot();
}

export function listProblems(filter: ProblemFilter = {}): WorkspaceProblemRecord[] {
  const out: WorkspaceProblemRecord[] = [];
  for (const problem of problemsById.values()) {
    if (!matchesProblemFilter(problem, filter)) {
      continue;
    }
    out.push(problem);
  }
  out.sort(compareProblemRecordsForDisplay);
  return out;
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
    const next = toActiveProblemRecord(p, existing);
    if (existing && problemRecordsEqual(existing, next)) {
      continue;
    }
    problemsById.set(p.id, next);
    changed = true;
  }

  // Mark stale problems under prefix as resolved; keep history until explicit clear.
  const resolvedAt = formatUnifiedTimestamp(new Date());
  for (const id of problemsById.keys()) {
    if (!id.startsWith(prefix)) continue;
    if (keepIds.has(id)) continue;
    const existing = problemsById.get(id);
    if (!existing || existing.resolved === true) continue;
    problemsById.set(id, {
      ...existing,
      resolved: true,
      resolvedAt,
    });
    changed = true;
  }

  if (changed) {
    problemsVersion++;
    broadcastSnapshot();
  }
}

export function clearResolvedProblems(): number {
  return clearProblems({ resolved: true });
}

export function clearProblems(filter: ProblemFilter = {}): number {
  let removed = 0;
  for (const [id, problem] of problemsById.entries()) {
    if (!matchesProblemFilter(problem, filter)) continue;
    problemsById.delete(id);
    removed += 1;
  }
  if (removed > 0) {
    problemsVersion++;
    broadcastSnapshot();
  }
  return removed;
}

function broadcastSnapshot(): void {
  if (!broadcastToClients) {
    return;
  }
  broadcastToClients(createProblemsSnapshotMessage());
}

function problemPayloadEqual(a: WorkspaceProblem, b: WorkspaceProblem): boolean {
  return (
    a.kind === b.kind &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.message === b.message &&
    JSON.stringify(a.detail) === JSON.stringify(b.detail)
  );
}

function problemRecordsEqual(a: WorkspaceProblemRecord, b: WorkspaceProblemRecord): boolean {
  return (
    problemPayloadEqual(a, b) &&
    a.occurredAt === b.occurredAt &&
    a.resolved === b.resolved &&
    a.resolvedAt === b.resolvedAt
  );
}

function toActiveProblemRecord(
  problem: WorkspaceProblem,
  existing: WorkspaceProblemRecord | undefined,
): WorkspaceProblemRecord {
  const occurredAt =
    typeof problem.timestamp === 'string' && problem.timestamp.trim() !== ''
      ? problem.timestamp
      : formatUnifiedTimestamp(new Date());
  if (!existing) {
    return {
      ...problem,
      occurredAt,
      resolved: false,
      resolvedAt: null,
    };
  }

  // A resolved problem becoming desired again starts a new active lifecycle.
  if (existing.resolved === true) {
    return {
      ...problem,
      occurredAt,
      resolved: false,
      resolvedAt: null,
    };
  }

  return {
    ...problem,
    occurredAt: existing.occurredAt ?? occurredAt,
    resolved: false,
    resolvedAt: null,
  };
}

function matchesProblemFilter(problem: WorkspaceProblemRecord, filter: ProblemFilter): boolean {
  if (filter.source !== undefined && problem.source !== filter.source) {
    return false;
  }
  if (filter.problemId !== undefined && problem.id !== filter.problemId) {
    return false;
  }
  if (filter.resolved !== undefined && (problem.resolved === true) !== filter.resolved) {
    return false;
  }
  if (filter.path !== undefined) {
    const problemPath = getProblemPath(problem);
    if (problemPath === null) {
      return false;
    }
    if (normalizeComparablePath(problemPath) !== normalizeComparablePath(filter.path)) {
      return false;
    }
  }
  return true;
}

function getProblemPath(problem: WorkspaceProblemRecord): string | null {
  switch (problem.kind) {
    case 'team_workspace_config_error':
    case 'mcp_workspace_config_error':
      return problem.detail.filePath;
    case 'mcp_server_error':
    case 'mcp_tool_collision':
    case 'mcp_tool_blacklisted':
    case 'mcp_tool_not_whitelisted':
    case 'mcp_tool_invalid_name':
    case 'llm_provider_rejected_request':
    case 'generic_problem':
      return null;
  }
}

function normalizeComparablePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function compareProblemRecordsForDisplay(
  a: WorkspaceProblemRecord,
  b: WorkspaceProblemRecord,
): number {
  const activeA = a.resolved === true ? 0 : 1;
  const activeB = b.resolved === true ? 0 : 1;
  if (activeA !== activeB) {
    return activeB - activeA;
  }
  const severityA = a.severity === 'error' ? 3 : a.severity === 'warning' ? 2 : 1;
  const severityB = b.severity === 'error' ? 3 : b.severity === 'warning' ? 2 : 1;
  if (severityA !== severityB) {
    return severityB - severityA;
  }
  const updatedA = a.resolved === true && a.resolvedAt ? a.resolvedAt : a.timestamp;
  const updatedB = b.resolved === true && b.resolvedAt ? b.resolvedAt : b.timestamp;
  const updatedCmp = updatedB.localeCompare(updatedA);
  if (updatedCmp !== 0) {
    return updatedCmp;
  }
  return a.id.localeCompare(b.id);
}
