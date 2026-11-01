import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  'toolsets/registry.ts',
  'mcp-config.ts',
  'mcp-disable.ts',
  'mcp-streamable-http-diagnostics.ts',
  'team-imports-members.ts',
  'team_mgmt-derived-problems-refresh.ts',
  'team_mgmt-problems-lifecycle.ts',
  'team_mgmt-ws-mod-parity.ts',

  'toolsets/team-mgmt-output-truncation.ts',
  'toolsets/tool-availability-snapshot.ts',
  'team-file-ext-permissions.ts',
  'team-yaml-parsing.ts',
  'team_mgmt-validate-team-manual-guidance.ts',
  'team_mgmt-manual/mcp-manual-content.ts',
  'team_mgmt-manual/mcp-validate-manual-errors.ts',
  'team_mgmt-manual/mcp-hot-reload-manual-problems.ts',
  'team_mgmt-mcp-runtime-diagnostics.ts',
];

const appsConfiguration = [
  'apps-app-lock-no-jitter-on-enable-disable.ts',
  'apps-resolution-assignedPort-noop.ts',
  'apps-resolution-assignedPort-reassign-on-conflict.ts',
  'apps-resolution-default-strategy-local.ts',
  'apps-resolution-effective-enabled-writeback.ts',
  'apps-resolution-issues-to-problems.ts',
  'apps-teammates-override-precedence.ts',
  'apps-cli-doctor-guidance.ts',
  'apps-doctor-handshake-diagnostics.ts',
  'apps-doctor-self-target.ts',
  'apps-install-configure-use-flow.ts',
];

const appsRuntime = [
  'apps-host-ipc-contract.ts',
  'apps-host-restart-on-local-host-change.ts',
  'apps-tool-proxy-refresh.ts',
  'apps-webui-self-heal-empty-resolution.ts',
  'apps-webui-startup-host-failure-no-interrupt.ts',
];

const appsExternal = [
  'apps-web-dev-session-core-contract.ts',
  'apps-web-dev-session-observer-reminders.ts',
  'apps-web-dev-session-qa-contract.ts',
  'apps-web-dev-session-runtime-transitions.ts',
];

const manual = [
  'toolsets/skills-tools.ts',
  'toolsets/memory-access.ts',
  'language.ts',
  'minds/mindset-i18n.ts',
  'minds/skills-i18n.ts',
  'snippets/catalog-i18n.ts',
  'toolsets/manual-behavior.ts',
  'toolsets/manual-size-guard.ts',
];
const filesystem = [
  'toolsets/list-dir-output-truncation.ts',
  'toolsets/picture-tools.ts',
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
const reminders = [
  'reminders/main-dialog-goal-reminder.ts',
  'reminders/reminder-display-order.ts',
  'reminders/reminder-render-mode.ts',
  'reminders/delete-reminder-empty-state.ts',
  'reminders/delete-reminder-meta-guard.ts',
  'reminders/update-reminder-meta-guard.ts',
  'reminders/delete-reminder-round-snapshot.ts',
  'reminders/stale-target-message.ts',
  'reminders/reminder-owner-failure-loud.ts',
  'reminders/task-agent-reminder-scope.ts',
  'reminders/migrate-reminder-scope.ts',
  'reminders/context-health-continuation.ts',
  'reminders/pending-tellask-reminder-order.ts',
  'reminders/pending-tellask-zero-state-no-jitter.ts',
];
const daemon = [
  'reminders/daemon-exit-wake-event.ts',
  'reminders/daemon-reminder-gone-exit-snapshot.ts',
  'reminders/daemon-reminder-no-jitter-without-output-change.ts',
  'reminders/daemon-reminder-render.ts',
  'reminders/daemon-reminder-retained-after-exit.ts',
  'reminders/get-daemon-output-stream-selection.ts',
  'reminders/shared-daemon-reminder-command-mismatch.ts',
  'reminders/shared-daemon-reminder-persistence.ts',
  'reminders/shared-daemon-reminder-wrapper-command-match.ts',
];
const presentation = [
  'kernel/unified-timestamp-ordering.ts',
  'llm-generation-metadata.ts',
  'log-priority-fields.ts',
  'webapp/run-control-visual.ts',
  'webapp/create-dialog-flow-ime.ts',
  'webapp/create-dialog-flow-selection.ts',
];
const components = [
  'reminders/app-reminder-render-mode-preserve.ts',
  'apps-host-tool-result-contract.ts',
];
const shell = [
  'toolsets/shell-cmd-capture-env.ts',
  'toolsets/shell-cmd-fast-completion.ts',
  'toolsets/shell-cmd-output-truncation.ts',
  'toolsets/shell-cmd-stdin-ignore.ts',
  'toolsets/shell-cmd-windows-spawn-spec.ts',
  'toolsets/readonly-shell.ts',
  'stop-daemon-windows-process-tree.ts',
  'ripgrep-streaming.ts',
  'ripgrep-windows-compat.ts',
];
const providerLive = [
  'provider/anthropic-streaming.ts',
  'provider/openai-streaming.ts',
  'provider/codex-streaming.ts',
  'provider/func-call.ts',
  'provider/stream-func-call.ts',
  'provider/minimax-json-response.ts',
  'provider/minimax-m27-multi-tool-probe.ts',
  'provider/openai-multi-tool-probe.ts',
  'provider/minimax-m27-turn-assembly.ts',
  'provider/volcengine-coding-plan-live-smoke.ts',
  'provider/volcengine-coding-plan-reasoning-live.ts',
];
const serverLocal = [
  'server-dialog-forensics-zip.ts',
  'auth.ts',
  'certificates.ts',
  'setup-env-input.ts',
  'setup-shell-env.ts',
  'webui-port-selection.ts',
  'ws-language.ts',
];
const providerLocal = [
  'codex-auth-alignment.ts',
  'codex-auth-refresh.ts',
  'provider/setup-rtws-custom-provider.ts',
  'provider/openai-reasoning-mode.ts',
  'provider/live-probe-controls.ts',
  'provider/anthropic-multi-tool-use-stream.ts',
  'provider/anthropic-stream-errors.ts',
  'provider/anthropic-whitespace.ts',
  'provider/openai-whitespace.ts',
  'provider/codex-instructions.ts',
  'provider/codex-service-tier.ts',
  'provider/tool-choice-requirement.ts',
];
const taskdoc = ['task-package.ts', 'taskdoc-search.ts', 'taskdoc-recall-budget.ts'];
const semanticSuites = {
  'apps-external': appsExternal,
  'apps-runtime': ['apps-tool-proxy-refresh.ts'],
  'apps-configuration': appsConfiguration.filter((file) =>
    [
      'apps-app-lock-no-jitter-on-enable-disable.ts',
      'apps-resolution-assignedPort-reassign-on-conflict.ts',
      'apps-resolution-effective-enabled-writeback.ts',
      'apps-resolution-issues-to-problems.ts',
      'apps-cli-doctor-guidance.ts',
      'apps-doctor-handshake-diagnostics.ts',
      'apps-doctor-self-target.ts',
      'apps-install-configure-use-flow.ts',
    ].includes(file),
  ),
  'server-local': ['auth.ts', 'certificates.ts', 'ws-language.ts'],
  'provider-local': [
    'provider/openai-reasoning-mode.ts',
    'codex-auth-alignment.ts',
    'codex-auth-refresh.ts',
    'provider/live-probe-controls.ts',
    'provider/anthropic-stream-errors.ts',
    'provider/codex-instructions.ts',
    'provider/codex-service-tier.ts',
    'provider/tool-choice-requirement.ts',
  ],
  taskdoc: ['task-package.ts', 'taskdoc-recall-budget.ts'],
  shell: shell.filter((file) => file !== 'toolsets/shell-cmd-capture-env.ts'),
  components,
  presentation: ['semantic/model-presentation.ts', 'semantic/context-usage-title.ts'],
  daemon,
  reminders: [
    'semantic/reminder-guidance.ts',
    'reminders/main-dialog-goal-reminder.ts',
    'reminders/reminder-render-mode.ts',
    'reminders/delete-reminder-empty-state.ts',
    'reminders/delete-reminder-meta-guard.ts',
    'reminders/update-reminder-meta-guard.ts',
    'reminders/delete-reminder-round-snapshot.ts',
    'reminders/stale-target-message.ts',
    'reminders/reminder-owner-failure-loud.ts',
    'reminders/task-agent-reminder-scope.ts',
    'reminders/migrate-reminder-scope.ts',
    'reminders/context-health-continuation.ts',
    'reminders/pending-tellask-reminder-order.ts',
    'reminders/pending-tellask-zero-state-no-jitter.ts',
  ],
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
    (file) =>
      ![
        'team_mgmt-manual/mcp-hot-reload-manual-problems.ts',
        'toolsets/tool-availability-snapshot.ts',
        'toolsets/registry.ts',
      ].includes(file),
  ),
  manual: [
    'toolsets/skills-tools.ts',
    'toolsets/manual-behavior.ts',
    'semantic/manual-guidance.ts',
    'toolsets/memory-access.ts',
  ],
};

async function sourceFiles(directory = testsRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (['node_modules', 'script-rtws', 'dist'].includes(entry.name)) return [];
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute);
      return entry.isFile() && ['.ts', '.mjs', '.cjs'].some((suffix) => entry.name.endsWith(suffix))
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
        /(?:tsx|node(?:\s+--test)?|--)\s+(?:(?:--isolated-rtws|--shared-rtws)\s+)*([\w./-]+\.(?:ts|mjs|cjs))(?:\s|$)/g,
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
      'run.mjs',
      'cli.ts',
      'rtws-script-runner.ts',
      'kernel-driver/helpers.ts',
      'semantic/evidence.ts',
      'semantic/context-guidance.ts',
    ].includes(file);
  const candidates = files.filter((file) => !support(file));
  const kernel = candidates.filter(
    (file) =>
      file.startsWith('kernel-driver/') || file === 'tellask/typeb-registered-sideDialog-dedupe.ts',
  );
  const suites = {
    smoke,
    kernel,
    context,
    configuration,
    'apps-configuration': appsConfiguration,
    'apps-runtime': appsRuntime,
    'apps-external': appsExternal,
    manual,
    filesystem,
    persistence,
    recovery,
    bootstrap,
    packaging,
    retry,
    projection,
    compatible,
    reminders,
    daemon,
    presentation,
    components,
    shell,
    taskdoc,
    'provider-local': providerLocal,
    'server-local': serverLocal,
    'provider-live': providerLive,
    runner: ['runner.test.mjs'],
  };
  const dedicatedSuites = { ...suites };
  suites.local = [
    ...new Set(
      Object.entries(suites)
        .filter(([name]) => name !== 'provider-live' && name !== 'apps-external')
        .flatMap(([, members]) => members),
    ),
  ];
  const included = new Set(Object.values(suites).flat());
  const audit = JSON.parse(await fs.readFile(path.join(testsRoot, 'audit.json'), 'utf8'));
  const unauditedCandidates = candidates.filter((file) => audit.cases[file]?.status !== 'reviewed');
  const identities = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash('sha256')
          .update(await fs.readFile(path.join(testsRoot, file)))
          .digest('hex'),
      ]),
    ),
  );
  const sourceReviewIssues = [];
  for (const file of files) {
    const kind = support(file) ? 'support' : 'candidate';
    const record = kind === 'support' ? audit.support?.[file] : audit.cases[file];
    const reasons = [];
    if (record?.status !== 'reviewed') reasons.push('review_required');
    if (!record?.reviewedSourceSha256) reasons.push('source_identity_missing');
    else if (record.reviewedSourceSha256 !== identities[file]) reasons.push('source_changed');
    if (typeof record?.evidence !== 'string' || !record.evidence.trim())
      reasons.push('review_evidence_missing');
    if (kind === 'candidate') {
      if (typeof record?.value !== 'string' || !record.value.trim())
        reasons.push('business_value_missing');
      if (
        !Object.hasOwn(dedicatedSuites, record?.lane) ||
        !dedicatedSuites[record.lane].includes(file)
      )
        reasons.push('execution_lane_missing');
    }
    if (reasons.length) sourceReviewIssues.push({ path: file, kind, reasons });
  }
  for (const [kind, records] of [
    ['candidate', audit.cases],
    ['support', audit.support ?? {}],
  ]) {
    for (const file of Object.keys(records)) {
      if (!(kind === 'candidate' ? candidates : files.filter(support)).includes(file))
        sourceReviewIssues.push({ path: file, kind, reasons: ['reviewed_source_missing'] });
    }
  }
  return {
    typescriptFiles: files.filter((file) => file.endsWith('.ts')).length,
    executableSourceFiles: files.length,
    sourceReview: {
      status: sourceReviewIssues.length ? 'required' : 'current',
      issues: sourceReviewIssues,
    },
    supportFiles: files.filter(support),
    candidates: candidates.length,
    suites,
    outsideSuites: candidates.filter((file) => !included.has(file)),
    withoutPackageScript: candidates.filter((file) => !registered.has(file)),
    missingPackageScriptTargets,
    unauditedCandidates,
    missingAuditedFiles: Object.keys(audit.cases).filter((file) => !candidates.includes(file)),
    note: 'Discovery, script registration and current reviewed-source identity are not measurements of assertion quality, behavior or semantic coverage. Missing package-script targets cover direct tsx/rtws and node JavaScript/TypeScript paths, including explicit shared/isolated flags, not arbitrary shell composition. Outside-suite candidates include live probes and external integrations; audit prerequisites before running them.',
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
    let prerequisite;
    // Only explicitly declared external lanes may use the structured prerequisite protocol.
    // Exit77 by itself remains a failure; no prose is interpreted to infer a skip.
    if (!timedOut && entry.skipExitCode !== undefined && outcome.code === entry.skipExitCode) {
      const records = (await fs.readFile(logPath, 'utf8')).split('\n').flatMap((line) => {
        try {
          const row = JSON.parse(line);
          return row &&
            typeof row === 'object' &&
            row.status === 'skipped' &&
            typeof row.code === 'string' &&
            typeof row.detail === 'string' &&
            (entry.prerequisiteBoundary === 'component'
              ? row.componentLoadAttempted === false
              : entry.prerequisiteBoundary === undefined ||
                  entry.prerequisiteBoundary === 'provider'
                ? row.providerRequestAttempted === false
                : false)
            ? [row]
            : [];
        } catch {
          return [];
        }
      });
      if (records.length === 1) prerequisite = records[0];
    }
    let executionEvidence;
    let evidenceFailure;
    if (!timedOut && outcome.code === 0 && entry.requireLiveEvidence) {
      try {
        const artifacts = (await fs.readFile(logPath, 'utf8')).split('\n').flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return row?.artifact === 'live-provider-observations' && typeof row.path === 'string'
              ? [row]
              : [];
          } catch {
            return [];
          }
        });
        if (artifacts.length !== 1)
          throw new Error(
            'A live transport run requires exactly one structured observations artifact',
          );
        const source = await fs.realpath(artifacts[0].path);
        const root = await fs.realpath(tempDir);
        const relative = path.relative(root, source);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
          throw new Error('Live evidence must remain in this process-owned directory');
        const material = JSON.parse(await fs.readFile(source, 'utf8'));
        if (
          material?.semanticAcceptance !== 'not-assessed' ||
          !Array.isArray(material.results) ||
          material.results.length === 0 ||
          !material.results.every(
            (row) => row && typeof row === 'object' && row.status === 'passed',
          )
        )
          throw new Error(
            'Live observations must contain completed passing transport attempts, without an automatic meaning verdict',
          );
        executionEvidence = {
          path: source,
          attempts: material.results.length,
          semanticAcceptance: 'not-assessed',
        };
      } catch (error) {
        evidenceFailure = {
          code: 'invalid_live_execution_evidence',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const status = timedOut
      ? 'timeout'
      : outcome.code === 0 && !evidenceFailure
        ? 'passed'
        : prerequisite
          ? 'skipped'
          : 'failed';
    const result = {
      id: entry.id,
      status,
      durationMs: Date.now() - started,
      ...outcome,
      logPath,
      ...(prerequisite ? { prerequisite } : {}),
      ...(executionEvidence ? { executionEvidence } : {}),
      ...(evidenceFailure ? { evidenceFailure } : {}),
    };
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
    skipped: results.filter((result) => result.status === 'skipped').length,
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
  const liveArgs = args[1] === 'provider-live' ? args.splice(2) : [];
  let selectedLiveCase;
  const caseIndex = liveArgs.indexOf('--case');
  if (caseIndex >= 0) {
    const requested = liveArgs[caseIndex + 1];
    selectedLiveCase = providerLive.find(
      (file) => file === requested || path.basename(file) === requested,
    );
    if (!selectedLiveCase)
      throw new Error('Select a registered live probe with --case <provider/file.ts>');
    liveArgs.splice(caseIndex, 2);
  }
  if (liveArgs.includes('--live') && !selectedLiveCase)
    throw new Error(
      'A live request run requires --case; do not dispatch every provider probe implicitly',
    );
  if (
    args.length !== 2 ||
    args[0] !== '--suite' ||
    ![
      'smoke',
      'local',
      'runner',
      'kernel',
      'context',
      'configuration',
      'apps-configuration',
      'apps-runtime',
      'apps-external',
      'manual',
      'filesystem',
      'persistence',
      'recovery',
      'bootstrap',
      'packaging',
      'retry',
      'projection',
      'compatible',
      'reminders',
      'daemon',
      'presentation',
      'components',
      'shell',
      'taskdoc',
      'provider-local',
      'server-local',
      'provider-live',
    ].includes(args[1])
  ) {
    throw new Error(
      'Usage: node tests/run.mjs --list | --suite local | --suite runner | --suite smoke | --suite kernel | --suite context [--semantic] | --suite configuration [--semantic] | --suite apps-configuration [--semantic] | --suite apps-runtime [--semantic] | --suite apps-external [--semantic] | --suite manual [--semantic] | --suite filesystem [--semantic] | --suite persistence [--semantic] | --suite recovery [--semantic] | --suite bootstrap [--semantic] | --suite packaging [--semantic] | --suite retry [--semantic] | --suite projection [--semantic] | --suite compatible [--semantic] | --suite reminders [--semantic] | --suite daemon [--semantic] | --suite presentation [--semantic] | --suite components [--semantic] | --suite shell [--semantic] | --suite taskdoc [--semantic] | --suite provider-local [--semantic] | --suite server-local [--semantic] | --suite provider-live [--case <provider/file.ts> --live --provider <id> --model <id>]',
    );
  }
  const suite = args[1];
  if (semantic && !Object.hasOwn(semanticSuites, suite)) {
    throw new Error('--semantic requires a suite with explicit evidence producers');
  }
  const catalog = await inventory();
  const files = selectedLiveCase
    ? [selectedLiveCase]
    : semantic
      ? semanticSuites[suite]
      : catalog.suites[suite];
  if (!files.length) throw new Error(`Suite ${suite} discovered no tests`);
  if (!semantic && catalog.sourceReview.status !== 'current') {
    console.error(
      JSON.stringify({
        artifact: 'test-source-review-block',
        code: 'source_review_required',
        attemptedCases: 0,
        selectedCases: files,
        sourceReview: catalog.sourceReview,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const tsx = require.resolve('tsx/cli');
  const cases = files.map((file) => ({
    id: file,
    ...(suite === 'provider-live' ? { skipExitCode: 77, requireLiveEvidence: true } : {}),
    ...(suite === 'apps-external' ? { skipExitCode: 77, prerequisiteBoundary: 'component' } : {}),
    args:
      file === 'runner.test.mjs'
        ? ['--test', path.join(testsRoot, file)]
        : (suite !== 'smoke' &&
              suite !== 'packaging' &&
              !(suite === 'local' && packaging.includes(file))) ||
            persistence.includes(file) ||
            recovery.includes(file) ||
            presentation.includes(file) ||
            configuration.includes(file)
          ? [
              tsx,
              path.join(testsRoot, 'cli.ts'),
              '--',
              file,
              ...liveArgs,
              ...(semantic ? ['--semantic'] : []),
            ]
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
    keepSuccessfulState: semantic || suite === 'provider-live' || suite === 'apps-external',
    report: semantic ? (line) => console.log(`GENERATION PROCESS ${line}`) : console.log,
  });
  summary.sourceReview = catalog.sourceReview;
  summary.semanticAcceptance = semantic ? 'pending' : 'not-assessed';
  await fs.writeFile(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (semantic) {
    await fs.writeFile(
      path.join(logDir, 'summary.json'),
      `${JSON.stringify({ ...summary, scope: 'evidence-generation-processes', semanticAcceptance: 'pending' }, null, 2)}\n`,
    );
    console.log(
      `Generation processes: ${summary.passed} completed, ${summary.failed} failed, ${summary.timedOut} timed out, ${summary.skipped} skipped. Semantic acceptance: PENDING subjective review. Evidence: ${logDir}`,
    );
  } else {
    console.log(
      `Total ${summary.total}: ${summary.passed} passed, ${summary.failed} failed, ${summary.timedOut} timed out, ${summary.skipped} skipped. Evidence: ${logDir}`,
    );
  }
  console.log(
    JSON.stringify({ artifact: 'suite-summary', suite, path: path.join(logDir, 'summary.json') }),
  );
  if (summary.failed || summary.timedOut) process.exitCode = 1;
  else if (summary.skipped) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
