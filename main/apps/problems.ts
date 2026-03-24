import type { WorkspaceProblem } from '@longrun-ai/kernel/types/problems';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { reconcileProblemsByPrefix } from '../problems';

import type { AppsResolutionIssue } from './enabled-apps';

const APPS_PROBLEM_PREFIX = 'apps/apps_resolution/';

function sanitizeProblemIdSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function buildAppsIssueProblemId(issue: AppsResolutionIssue): string {
  const kindSeg = sanitizeProblemIdSegment(issue.kind);

  const appId = asNonEmptyString(issue.detail['appId']);
  const depId = asNonEmptyString(issue.detail['dependencyId']);

  if (appId && depId) {
    return `${APPS_PROBLEM_PREFIX}${kindSeg}/${sanitizeProblemIdSegment(appId)}/${sanitizeProblemIdSegment(depId)}`;
  }
  if (appId) {
    return `${APPS_PROBLEM_PREFIX}${kindSeg}/${sanitizeProblemIdSegment(appId)}`;
  }
  return `${APPS_PROBLEM_PREFIX}${kindSeg}`;
}

export function reconcileAppsResolutionIssuesToProblems(params: {
  issues: ReadonlyArray<AppsResolutionIssue>;
}): void {
  const now = formatUnifiedTimestamp(new Date());
  const desired: WorkspaceProblem[] = [];

  for (const issue of params.issues) {
    desired.push({
      kind: 'generic_problem',
      source: 'system',
      id: buildAppsIssueProblemId(issue),
      severity: issue.severity,
      timestamp: now,
      message: issue.message,
      detail: { text: JSON.stringify(issue.detail, null, 2) },
    });
  }

  reconcileProblemsByPrefix(APPS_PROBLEM_PREFIX, desired);
}
