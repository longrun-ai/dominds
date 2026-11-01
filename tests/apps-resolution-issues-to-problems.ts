import assert from 'node:assert/strict';
import path from 'node:path';

import { loadEnabledAppsSnapshot } from '../main/apps/enabled-apps';
import { reconcileAppsResolutionIssuesToProblems } from '../main/apps/problems';
import {
  clearProblems,
  getProblemsSnapshot,
  listProblems,
  removeProblem,
  removeProblemsByPrefix,
  upsertProblem,
} from '../main/problems';
import { writeAppManifest, writeAppText, writeLocalApp } from './helpers/app-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-problems-');
const prefix = 'apps/apps_resolution/';
const appProblems = () =>
  getProblemsSnapshot().problems.filter((problem) => problem.id.startsWith(prefix));
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const id = 'missing_required_app';
    const unrelatedId = 'owned-unrelated-problem';
    removeProblemsByPrefix(prefix);
    upsertProblem({
      id: unrelatedId,
      kind: 'generic_problem',
      source: 'system',
      severity: 'warning',
      timestamp: new Date().toISOString(),
      message: 'unrelated-provided-data',
      detail: { text: 'unrelated-detail-data' },
    });
    const unrelated = listProblems({ problemId: unrelatedId });
    try {
      await writeAppManifest(rtws, 'rtws_root', [id]);
      const missing = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
      assert.deepEqual(missing.enabledApps, []);
      assert.equal(missing.issues.length, 1);
      assert.equal(missing.issues[0].kind, 'required_dependency_missing');
      assert.equal(missing.issues[0].detail.appId, id);
      reconcileAppsResolutionIssuesToProblems({ issues: missing.issues });
      const active = appProblems();
      assert.equal(active.length, 1);
      assert.equal(active[0].resolved, false);
      assert.equal(active[0].severity, missing.issues[0].severity);
      assert.equal(active[0].source, 'system');
      // Full message equality here protects actual forwarding fidelity, never its meaning.
      assert.equal(active[0].message, missing.issues[0].message);
      assert.equal(active[0].kind, 'generic_problem');
      if (active[0].kind !== 'generic_problem') throw new Error('Expected a generic app Problem');
      assert.deepEqual(JSON.parse(active[0].detail?.text ?? 'null'), missing.issues[0].detail);
      reconcileAppsResolutionIssuesToProblems({ issues: missing.issues });
      assert.deepEqual(
        appProblems().map((problem) => problem.id),
        active.map((problem) => problem.id),
      );
      evidence.record({
        id: 'missing',
        scenario:
          'A required local package is absent; native resolution issues are forwarded to the Problems store.',
        businessValue:
          'The user can identify the missing package and a concrete recovery location.',
        context: { appId: id, enabledPackages: 0, activeProblems: 1, noRegistryRequests: true },
        reviewQuestions: [
          'Do the actual issue, detail and Problems message agree on the missing package and provide useful recovery information?',
          'Does the guidance describe the current compatibility configuration without claiming the retired architecture is the new destination?',
        ],
        actualText: JSON.stringify({ snapshot: missing, problems: active }, null, 2),
      });
      // Resolve the actual cause, rather than manufacturing reconcile([]) as a healthy resolver.
      await writeLocalApp(path.join(rtws, 'dominds-apps', id), id);
      const healthy = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
      assert.deepEqual(
        healthy.enabledApps.map((app) => app.id),
        [id],
      );
      assert.deepEqual(healthy.issues, []);
      reconcileAppsResolutionIssuesToProblems({ issues: healthy.issues });
      const resolved = appProblems();
      assert.deepEqual(
        resolved.map((problem) => problem.id),
        active.map((problem) => problem.id),
      );
      assert.ok(
        resolved.every(
          (problem) =>
            problem.resolved &&
            typeof problem.resolvedAt === 'string' &&
            Number.isFinite(Date.parse(problem.resolvedAt)),
        ),
      );
      assert.equal(
        listProblems({ resolved: false }).some((problem) => problem.id === active[0].id),
        false,
      );
      assert.equal(clearProblems({ problemId: active[0].id, resolved: true }), 1);
      assert.deepEqual(appProblems(), []);
      assert.deepEqual(listProblems({ problemId: unrelatedId }), unrelated);
      await writeAppText(
        path.join(rtws, '.apps', 'configuration.yaml'),
        `schemaVersion: 1\ndisabledApps: [${id}]\n`,
      );
      const disabled = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
      assert.deepEqual(disabled.enabledApps, []);
      assert.equal(disabled.issues.length, 1);
      assert.equal(disabled.issues[0].kind, 'required_dependency_disabled');
      reconcileAppsResolutionIssuesToProblems({ issues: disabled.issues });
      const disabledProblems = appProblems();
      assert.equal(disabledProblems.length, 1);
      assert.notEqual(disabledProblems[0].id, active[0].id);
      assert.equal(disabledProblems[0].resolved, false);
      assert.equal(disabledProblems[0].severity, disabled.issues[0].severity);
      assert.equal(disabledProblems[0].source, 'system');
      assert.equal(disabledProblems[0].message, disabled.issues[0].message);
      assert.equal(disabledProblems[0].kind, 'generic_problem');
      if (disabledProblems[0].kind !== 'generic_problem')
        throw new Error('Expected a generic app Problem');
      assert.deepEqual(
        JSON.parse(disabledProblems[0].detail?.text ?? 'null'),
        disabled.issues[0].detail,
      );
      assert.deepEqual(listProblems({ problemId: unrelatedId }), unrelated);
      evidence.record({
        id: 'disabled',
        scenario:
          'The package now exists, but configuration explicitly disables it while the root still requires it.',
        businessValue:
          'The user can distinguish a missing package from a disabled one and use the correct recovery path.',
        context: {
          appId: id,
          enabledPackages: 0,
          activeProblems: 1,
          oldMissingProblemCleared: true,
        },
        reviewQuestions: [
          'Does the complete issue/Problems text correctly describe an installed but disabled required package?',
          'Is the proposed configuration location consistent with the actual scenario?',
        ],
        actualText: JSON.stringify({ snapshot: disabled, problems: disabledProblems }, null, 2),
      });
    } finally {
      removeProblemsByPrefix(prefix);
      removeProblem(unrelatedId);
    }
  });
  await evidence.write();
  console.log(
    'real missing/disabled package issues preserve data, resolve after actual repair and clear without touching unrelated Problems: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
