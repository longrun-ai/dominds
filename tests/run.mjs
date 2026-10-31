import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const smoke = [
  'auth.ts',
  'llm-generation-metadata.ts',
  'persistence/latest-writeback.ts',
  'interruption-resumption.ts',
  'access-control/dialogs-root-deny.ts',
  'access-control/file-ext-names.ts',
  'apps-host-ipc-contract.ts',
  'toolsets/tool-availability-snapshot.ts',
  'webapp/create-dialog-flow-ime.ts',
  'webapp/create-dialog-flow-selection.ts',
  'webapp/generation-model-presentation.ts',
];
const context = [
  'websocket-user-msg-generation-boundary.ts',
  'context-health/caution-cadence.ts',
  'context-health/critical-user-interjection.ts',
  'diligence-push/auto-continue-prompt-format.ts',
  'diligence-push/retry-recovery-bypasses-budget.ts',
  'diligence-push/q4h-diligence-push-i18n.ts',
  'diligence-push/diligence-budget-event.ts',
  'diligence-push/q4h-global-broadcast.ts',
];

const configuration = [
  'team-file-ext-permissions.ts',
  'team-yaml-parsing.ts',
  'team_mgmt-validate-team-manual-guidance.ts',
  'team_mgmt-manual/mcp-manual-content.ts',
  'team_mgmt-manual/mcp-validate-manual-errors.ts',
  'team_mgmt-manual/mcp-hot-reload-manual-problems.ts',
  'team_mgmt-mcp-runtime-diagnostics.ts',
];

const manual = [
  'language.ts',
  'minds/mindset-i18n.ts',
  'minds/skills-i18n.ts',
  'snippets/catalog-i18n.ts',
  'toolsets/manual-behavior.ts',
  'toolsets/manual-size-guard.ts',
];
const filesystem = [
  'overwrite-entire-file.ts',
  'occurrence-replace.ts',
  'team_mgmt-create-new-file.ts',
  'team_mgmt-file-range-edit.ts',
  'team_mgmt-occurrence-replace.ts',
  'reminders/ws-mod-pad.ts',
  'access-control/dialogs-root-deny.ts',
  'access-control/file-ext-names.ts',
  'fs-symlink-follow.ts',
  'create-new-file.ts',
  'file-block-tools.ts',
  'file-range-edit.ts',
  'edit-output-truncation.ts',
];
const persistence = [
  'persistence/call-duplicate-callid-loud.ts',
  'persistence/cross-course-tellask-requires-carryover-content.ts',
  'persistence/dialog-fork.ts',
  'persistence/fork-sideDialog-creation.ts',
  'persistence/malformed-main-dialog-quarantine.ts',
  'persistence/nested-sideDialog-created-parent-context.ts',
  'persistence/restore-preserves-unpaired-tool-events.ts',
  'persistence/tellask-result-duplicate-callid-loud.ts',
  'persistence/tellask-result-requires-canonical-fields.ts',
  'persistence/ui-only-markdown-replay-event.ts',

  'persistence/latest-writeback.ts',
  'persistence/thinking-reasoning-replay-event.ts',
  'persistence/asker-stack-jsonl.ts',
  'persistence/sideDialog-reconciled-course.ts',
  'persistence/move-dialog-status.ts',
  'persistence/reminders-owner-meta.ts',
  'persistence/reminders-status-path.ts',
  'persistence/runtime-guide-fork-anchor.ts',
  'persistence/priming-reminders.ts',
];
const recovery = [
  'interruption-resumption.ts',
  'interruption-llm-retry-stopped-resumable.ts',
  'recovery/open-generation-recovery-stale-clears-on-backend-loop.ts',
  'recovery/reply-delivery-live-continuation.ts',
  'recovery/reply-delivery-recovery-after-restart.ts',
  'recovery/reply-delivery-recovery-waits-for-q4h.ts',
];
const bootstrap = [
  'cli/env-proxy-support.ts',
  'cli/man-subcommand.ts',
  'cli/rtws-cli.ts',
  'cli/subcommand-argv-isolation.ts',
  'cli/validate-team-def-subcommand.ts',
  'env/dotenv.ts',
  'env/env-tools.ts',
];
const packaging = [
  'apps-dominds-root-packed-contract.ts',
  'apps-kernel-shell-packed-contract.ts',
  'apps-kernel-package-exports-contract.ts',
  'apps-public-version-drift-guard.ts',
  'apps-public-publish-guard.ts',
];
const retry = [
  'provider/llm-quirks-retry-handling.ts',
  'provider/retry-request-lifecycle.ts',
  'provider/retry-empty-recovery.ts',
];
const projection = [
  'provider/openai-context-normalization.ts',
  'provider/anthropic-context-normalization.ts',
  'provider/openai-compatible-context-normalization.ts',
  'provider/tool-result-image-size-fallback.ts',
  'provider/openai-compatible-image-fallback.ts',
  'provider/user-image-model-support.ts',
  'provider/tool-result-truncation.ts',
];
const compatible = [
  'provider/openai-compatible-kimi-code.ts',
  'provider/openai-compatible-volcengine-coding-plan.ts',
];
const semanticSuites = {
  compatible,
  projection,
  retry,
  packaging: [
    'apps-kernel-package-exports-contract.ts',
    'apps-public-version-drift-guard.ts',
    'apps-public-publish-guard.ts',
  ],
  context: [
    'semantic/context-guidance.ts',
    'diligence-push/diligence-budget-event.ts',
    'diligence-push/q4h-diligence-push-i18n.ts',
  ],
  bootstrap: ['cli/man-subcommand.ts', 'cli/validate-team-def-subcommand.ts', 'env/env-tools.ts'],
  recovery: [
    'interruption-resumption.ts',
    'recovery/reply-delivery-live-continuation.ts',
    'recovery/reply-delivery-recovery-after-restart.ts',
    'recovery/reply-delivery-recovery-waits-for-q4h.ts',
  ],
  persistence: [
    'persistence/asker-stack-jsonl.ts',
    'persistence/move-dialog-status.ts',
    'persistence/cross-course-tellask-requires-carryover-content.ts',
    'persistence/malformed-main-dialog-quarantine.ts',
  ],
  filesystem: filesystem.filter((file) => !file.startsWith('access-control/')),
  kernel: [
    'kernel-driver/sideDialog-askback-auto-resume-while-pending-registered-sideDialog.ts',
    'kernel-driver/sideDialog-reply-delivery-marked-delivered.ts',
    'kernel-driver/tellask-resolved-result-context-pointer.ts',
    'kernel-driver/user-interject-active-callee-suppresses-reply-guidance.ts',
    'kernel-driver/user-interject-active-callee-tool-followup.ts',
    'kernel-driver/fbr-internal-conclusion-flow.ts',
    'kernel-driver/retry-recovery-diligence-push-with-keep-going-disabled.ts',
    'kernel-driver/context-health-large-tool-output-hidden.ts',
    'kernel-driver/context-health-multi-iter-gate.ts',
    'kernel-driver/critical-queued-user-interjection.ts',
    'kernel-driver/func-call-persists-before-result.ts',
    'kernel-driver/root-tellask-background-callee-badge-event.ts',
    'kernel-driver/sideDialog-askback-reply-tool-no-double-delivery.ts',
    'kernel-driver/multiple-askhuman-invalid.ts',
    'kernel-driver/mock-provider-contract.ts',
    'kernel-driver/invalid-json-tool-call-feedback.ts',
    'kernel-driver/llm-request-failure-single-stream-error.ts',
    'kernel-driver/sideDialog-direct-fallback-thinking.ts',
    'kernel-driver/runtime-reminder-context.ts',
    'kernel-driver/repeated-tool-call-reminder.ts',
    'kernel-driver/reply-tool-dynamic-guidance.ts',
    'kernel-driver/answering-a2h-side-reply-reminder.ts',
    'semantic/reply-guidance.ts',
    'kernel-driver/mainline-reply-obligation-reminder-direct-fallback.ts',
    'kernel-driver/clear-mind-blocks-on-sibling-tool-failure.ts',
    'kernel-driver/clear-mind-critical-auto-course.ts',
    'kernel-driver/sideDialog-clear-mind-keeps-pending-round.ts',
    'kernel-driver/sideDialog-new-course-prompt-survives-restore.ts',
    'kernel-driver/sideDialog-new-course-update-reminder-followup.ts',
    'kernel-driver/sideDialog-no-empty-autodrive-after-final-response.ts',
    'kernel-driver/sideDialog-queue-interrupt-rollback.ts',
    'kernel-driver/sideDialog-registered-update-clear-mind-rebinds-reply-target.ts',
    'kernel-driver/sideDialog-registered-update-queues-queued-prompt.ts',
    'kernel-driver/sideDialog-registered-update-replaces-pending-round.ts',
  ],
  configuration: configuration.filter(
    (file) => file !== 'team_mgmt-manual/mcp-hot-reload-manual-problems.ts',
  ),
  manual: ['toolsets/manual-behavior.ts', 'semantic/manual-guidance.ts'],
};

async function sourceFiles(directory = testsRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (['node_modules', 'script-rtws', 'dist'].includes(entry.name)) return [];
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return entry.isFile() && entry.name.endsWith('.ts')
        ? [path.relative(testsRoot, absolute).split(path.sep).join('/')]
        : [];
    }),
  );
  return groups.flat().sort();
}

export async function inventory() {
  const files = await sourceFiles();
  const { scripts } = JSON.parse(await fs.readFile(path.join(testsRoot, 'package.json'), 'utf8'));
  const registrations = Object.entries(scripts).flatMap(([script, command]) =>
    [
      ...command.matchAll(
        /(?:tsx|--)\s+(?:(?:--isolated-rtws|--shared-rtws)\s+)*([\w./-]+\.ts)(?:\s|$)/g,
      ),
    ].map((match) => ({
      script,
      target: match[1],
    })),
  );
  const registered = new Set(registrations.map(({ target }) => target));
  const missingPackageScriptTargets = [];
  for (const registration of registrations) {
    try {
      if (!(await fs.stat(path.resolve(testsRoot, registration.target))).isFile())
        missingPackageScriptTargets.push(registration);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      missingPackageScriptTargets.push(registration);
    }
  }
  const support = (file) =>
    file.startsWith('helpers/') ||
    file.startsWith('semantic/') ||
    [
      'cli.ts',
      'rtws-script-runner.ts',
      'kernel-driver/helpers.ts',
      'reminders/daemon-test-utils.ts',
      'semantic/evidence.ts',
      'semantic/context-guidance.ts',
    ].includes(file);
  const candidates = files.filter((file) => !support(file));
  const kernel = candidates.filter((file) => file.startsWith('kernel-driver/'));
  const suites = {
    smoke,
    kernel,
    context,
    configuration,
    manual,
    filesystem,
    persistence,
    recovery,
    bootstrap,
    packaging,
    retry,
    projection,
    compatible,
  };
  const included = new Set(Object.values(suites).flat());
  const audit = JSON.parse(await fs.readFile(path.join(testsRoot, 'audit.json'), 'utf8'));
  const unauditedCandidates = candidates.filter((file) => audit.cases[file]?.status !== 'reviewed');
  return {
    typescriptFiles: files.length,
    supportFiles: files.filter(support),
    candidates: candidates.length,
    suites,
    outsideSuites: candidates.filter((file) => !included.has(file)),
    withoutPackageScript: candidates.filter((file) => !registered.has(file)),
    missingPackageScriptTargets,
    unauditedCandidates,
    missingAuditedFiles: Object.keys(audit.cases).filter((file) => !candidates.includes(file)),
    note: 'Discovery and script registration are not measurements of behavior or line coverage. Missing package-script targets cover direct tsx/rtws TypeScript paths, including explicit shared/isolated flags, not arbitrary shell composition. Outside-suite candidates include live probes and external integrations; audit prerequisites before running them.',
  };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

export async function runCases(
  cases,
  { logDir, timeoutMs = 60_000, report = console.log, keepSuccessfulState = false },
) {
  await fs.mkdir(logDir, { recursive: true });
  const results = [];
  for (const [index, entry] of cases.entries()) {
    const name = `${String(index + 1).padStart(3, '0')}-${entry.id.replace(/[^\w.-]/g, '_')}`;
    const logPath = path.join(logDir, `${name}.log`);
    // tsx opens a Unix-domain socket under TMPDIR, whose path length is limited.
    const tempDir = path.join(logDir, `${index + 1}.tmp`);
    await fs.mkdir(tempDir);
    const output = await fs.open(logPath, 'w');
    const started = Date.now();
    let timedOut = false;
    const outcome = await new Promise((resolve) => {
      const child = spawn(process.execPath, entry.args, {
        cwd: entry.cwd ?? testsRoot,
        detached: process.platform !== 'win32',
        stdio: ['ignore', output.fd, output.fd],
        env: {
          ...process.env,
          TMPDIR: tempDir,
          TEMP: tempDir,
          TMP: tempDir,
          DOMINDS_TEST_RTWS_KEEP_TMP: '1',
        },
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error.message });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    await output.close();
    const status = timedOut ? 'timeout' : outcome.code === 0 ? 'passed' : 'failed';
    const result = { id: entry.id, status, durationMs: Date.now() - started, ...outcome, logPath };
    if (status === 'passed' && !keepSuccessfulState)
      await fs.rm(tempDir, { recursive: true, force: true });
    else result.tempDir = tempDir;
    results.push(result);
    report(
      `${status.toUpperCase()} ${entry.id} (${result.durationMs}ms)${status === 'passed' ? '' : ` — ${logPath}`}`,
    );
  }
  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    timedOut: results.filter((result) => result.status === 'timeout').length,
    results,
  };
  await fs.writeFile(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify(await inventory(), null, 2));
    return;
  }
  const semantic = args.at(-1) === '--semantic';
  if (semantic) args.pop();
  if (
    args.length !== 2 ||
    args[0] !== '--suite' ||
    ![
      'smoke',
      'kernel',
      'context',
      'configuration',
      'manual',
      'filesystem',
      'persistence',
      'recovery',
      'bootstrap',
      'packaging',
      'retry',
      'projection',
      'compatible',
    ].includes(args[1])
  ) {
    throw new Error(
      'Usage: node tests/run.mjs --list | --suite smoke | --suite kernel | --suite context [--semantic] | --suite configuration [--semantic] | --suite manual [--semantic] | --suite filesystem [--semantic] | --suite persistence [--semantic] | --suite recovery [--semantic] | --suite bootstrap [--semantic] | --suite packaging [--semantic] | --suite retry [--semantic] | --suite projection [--semantic] | --suite compatible [--semantic]',
    );
  }
  const suite = args[1];
  if (semantic && !Object.hasOwn(semanticSuites, suite)) {
    throw new Error('--semantic requires a suite with explicit evidence producers');
  }
  const files = semantic ? semanticSuites[suite] : (await inventory()).suites[suite];
  if (!files.length) throw new Error(`Suite ${suite} discovered no tests`);
  const tsx = require.resolve('tsx/cli');
  const cases = files.map((file) => ({
    id: file,
    args:
      (suite !== 'smoke' && suite !== 'packaging') ||
      persistence.includes(file) ||
      recovery.includes(file)
        ? [tsx, path.join(testsRoot, 'cli.ts'), '--', file, ...(semantic ? ['--semantic'] : [])]
        : [
            tsx,
            '--tsconfig',
            path.join(testsRoot, 'tsconfig.json'),
            path.join(testsRoot, file),
            ...(semantic ? ['--semantic'] : []),
          ],
  }));
  const logDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `dominds-tests-${suite}${semantic ? '-semantic' : ''}-`),
  );
  console.log(
    `${semantic ? 'Evidence generation processes' : 'Suite'}: ${suite}; cases: ${cases.length}; evidence: ${logDir}`,
  );
  const summary = await runCases(cases, {
    logDir,
    keepSuccessfulState: semantic,
    report: semantic ? (line) => console.log(`GENERATION PROCESS ${line}`) : console.log,
  });
  if (semantic) {
    await fs.writeFile(
      path.join(logDir, 'summary.json'),
      `${JSON.stringify({ ...summary, scope: 'evidence-generation-processes', semanticAcceptance: 'pending' }, null, 2)}\n`,
    );
    console.log(
      `Generation processes: ${summary.passed} completed, ${summary.failed} failed, ${summary.timedOut} timed out. Semantic acceptance: PENDING subjective review. Evidence: ${logDir}`,
    );
  } else {
    console.log(
      `Total ${summary.total}: ${summary.passed} passed, ${summary.failed} failed, ${summary.timedOut} timed out. Evidence: ${logDir}`,
    );
  }
  if (summary.failed || summary.timedOut) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
