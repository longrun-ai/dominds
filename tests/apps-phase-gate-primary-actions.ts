import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type ToolCtx = Readonly<{
  dialogId: string;
  rootDialogId: string;
  agentId: string;
  callerId: string;
}>;

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<string | Readonly<{ output: string }>>;

type AppHost = Readonly<{
  tools: Readonly<Record<string, ToolHandler>>;
}>;

type HostModule = Readonly<{
  createDomindsAppHost: (ctx: {
    appId: string;
    rtwsRootAbs: string;
    rtwsAppDirAbs: string;
    packageRootAbs: string;
    kernel: { host: string; port: number };
    log: (
      level: 'info' | 'warn' | 'error',
      msg: string,
      data?: Readonly<Record<string, unknown>>,
    ) => void;
  }) => Promise<AppHost>;
}>;

function extractOutput(result: string | Readonly<{ output: string }>): string {
  return typeof result === 'string' ? result : result.output;
}

function parseJsonBlock(markdown: string): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match, 'expected status markdown to include a JSON block');
  const raw = match[1];
  assert.ok(raw, 'expected workflow policy JSON payload');
  const parsed: unknown = JSON.parse(raw);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Record<string, unknown>;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
}

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-phase-gate-primary-actions-'));
  const taskDocRel = 'control-case.tsk';
  const taskDocAbs = path.join(tmpRoot, taskDocRel);
  const reviewTaskDocRel = 'review-case.tsk';
  const reviewTaskDocAbs = path.join(tmpRoot, reviewTaskDocRel);
  const packageRootAbs = path.resolve(
    __dirname,
    '..',
    '..',
    'dominds-apps',
    '@longrun-ai',
    'phase-gate',
  );
  const hostModuleAbs = path.join(packageRootAbs, 'src', 'app-host.js');
  const rtwsAppDirAbs = path.join(tmpRoot, '.apps', '@longrun-ai', 'phase-gate');

  const flowMarkdown = `# Phase Gate Flow

\`\`\`phasegate
{
  "version": 1,
  "flowMentor": {
    "memberId": "@flow-mentor",
    "toolsets": ["phase_gate_status", "phase_gate_manage"]
  },
  "initialPhase": "alignment",
  "phases": [
    {
      "id": "alignment",
      "title": "Alignment",
      "gate": {
        "id": "alignment_signoff",
        "title": "Alignment sign-off",
        "toPhase": "implementation",
        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },
        "roles": [
          {
            "id": "owner",
            "members": ["@owner"],
            "toolsets": ["phase_gate_status", "phase_gate_review"]
          }
        ]
      }
    },
    {
      "id": "implementation",
      "title": "Implementation",
      "gate": {
        "id": "acceptance_input_check",
        "title": "Acceptance input check",
        "toPhase": "acceptance",
        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },
        "roles": [
          {
            "id": "builder",
            "members": ["@owner"],
            "toolsets": ["phase_gate_status", "phase_gate_review"]
          }
        ]
      }
    },
    {
      "id": "acceptance",
      "title": "Acceptance"
    }
  ]
}
\`\`\`

\`\`\`mermaid
flowchart LR
  alignment --> implementation
  implementation --> acceptance
\`\`\`
`;

  const stateMarkdown = `# Phase Gate State

\`\`\`phasegate-state
{
  "currentPhase": "implementation",
  "assessments": [],
  "votes": [],
  "history": [
    {
      "gateId": "alignment_signoff",
      "fromPhase": "alignment",
      "toPhase": "implementation",
      "advancedAt": "2026-03-11T00:00:00.000Z"
    }
  ],
  "control": null
}
\`\`\`
`;

  try {
    process.chdir(tmpRoot);
    await writeText(path.join(taskDocAbs, 'phasegate', 'flow.md'), flowMarkdown);
    await writeText(path.join(taskDocAbs, 'phasegate', 'state.md'), stateMarkdown);
    await writeText(path.join(reviewTaskDocAbs, 'phasegate', 'flow.md'), flowMarkdown);
    await writeText(path.join(reviewTaskDocAbs, 'phasegate', 'state.md'), stateMarkdown);

    const hostModuleUnknown = await import(pathToFileURL(hostModuleAbs).href);
    const hostModule = hostModuleUnknown as HostModule;
    const host = await hostModule.createDomindsAppHost({
      appId: '@longrun-ai/phase-gate',
      rtwsRootAbs: tmpRoot,
      rtwsAppDirAbs,
      packageRootAbs,
      kernel: { host: '127.0.0.1', port: 0 },
      log: () => undefined,
    });

    const toolCtx: ToolCtx = {
      dialogId: 'dlg-owner',
      rootDialogId: 'root-owner',
      agentId: 'owner',
      callerId: '@owner',
    };
    const flowMentorCtx: ToolCtx = {
      dialogId: 'dlg-flow-mentor',
      rootDialogId: 'root-flow-mentor',
      agentId: 'flow-mentor',
      callerId: '@flow-mentor',
    };

    const requestHumanDecision = host.tools.phase_gate_request_human_decision;
    assert.ok(requestHumanDecision, 'expected phase_gate_request_human_decision tool');
    const getStatus = host.tools.phase_gate_get_status;
    assert.ok(getStatus, 'expected phase_gate_get_status tool');
    const clearControl = host.tools.phase_gate_clear_control;
    assert.ok(clearControl, 'expected phase_gate_clear_control tool');
    const requestRollback = host.tools.phase_gate_request_rollback;
    assert.ok(requestRollback, 'expected phase_gate_request_rollback tool');
    const recordHumanDecision = host.tools.phase_gate_record_human_decision;
    assert.ok(recordHumanDecision, 'expected phase_gate_record_human_decision tool');
    const applyRollback = host.tools.phase_gate_apply_rollback;
    assert.ok(applyRollback, 'expected phase_gate_apply_rollback tool');
    const recordAssessment = host.tools.phase_gate_record_assessment;
    assert.ok(recordAssessment, 'expected phase_gate_record_assessment tool');
    const castVote = host.tools.phase_gate_cast_vote;
    assert.ok(castVote, 'expected phase_gate_cast_vote tool');

    const pendingReviewStatus = extractOutput(
      await getStatus({ taskDocPath: reviewTaskDocRel }, flowMentorCtx),
    );
    assert.match(pendingReviewStatus, /- primaryAction: `dispatch_to_role` -> `builder`/);
    const pendingReviewWorkflowPolicy = parseJsonBlock(pendingReviewStatus);
    assert.equal(pendingReviewWorkflowPolicy.blockingReason, 'await_gate_reviews');
    const pendingReviewUnlockBy = pendingReviewWorkflowPolicy.unlockBy;
    assertArray(pendingReviewUnlockBy, 'pending-review unlockBy');
    assert.equal(pendingReviewUnlockBy.length, 1);
    assertRecord(pendingReviewUnlockBy[0], 'pending-review unlock target');
    assert.equal(pendingReviewUnlockBy[0].type, 'member');
    assert.equal(pendingReviewUnlockBy[0].memberId, 'owner');
    assert.deepEqual(pendingReviewUnlockBy[0].roleIds, ['builder']);
    const pendingReviewPrimaryAction = pendingReviewWorkflowPolicy.primaryAction;
    assertRecord(pendingReviewPrimaryAction, 'pending-review primaryAction');
    assert.equal(pendingReviewPrimaryAction.kind, 'dispatch_to_role');
    assert.deepEqual(pendingReviewPrimaryAction.targetRoleIds, ['builder']);
    const pendingReviewTargets = pendingReviewPrimaryAction.targetMembers;
    assertArray(pendingReviewTargets, 'pending-review targetMembers');
    assert.equal(pendingReviewTargets.length, 1);
    assertRecord(pendingReviewTargets[0], 'pending-review target member');
    assert.equal(pendingReviewTargets[0].memberId, 'owner');
    assert.deepEqual(pendingReviewTargets[0].roleIds, ['builder']);

    const requestHumanOutput = extractOutput(
      await requestHumanDecision(
        {
          taskDocPath: taskDocRel,
          reason: 'Need product tradeoff choice.',
          blockedWithoutDecision: 'Acceptance cannot start without an explicit product call.',
          teamRecommendation: 'Prefer option A and keep the current implementation direction.',
          question: 'Should we accept the current behavior or require a product-level change?',
          options: ['Accept current behavior', 'Require product change before acceptance'],
          evidence: ['artifacts/acceptance-summary.md', 'artifacts/browser-run.png'],
        },
        toolCtx,
      ),
    );
    assert.match(requestHumanOutput, /Set human-decision control/);

    const humanStatus = extractOutput(await getStatus({ taskDocPath: taskDocRel }, toolCtx));
    assert.match(humanStatus, /- primaryAction: `request_human_decision`/);
    assert.match(humanStatus, /## Human decision handoff/);
    assert.match(
      humanStatus,
      /- blockedWithoutDecision: Acceptance cannot start without an explicit product call\./,
    );
    assert.match(
      humanStatus,
      /- teamRecommendation: Prefer option A and keep the current implementation direction\./,
    );
    assert.match(
      humanStatus,
      /- question: Should we accept the current behavior or require a product-level change\?/,
    );
    assert.match(
      humanStatus,
      /- options: Accept current behavior \| Require product change before acceptance/,
    );
    assert.match(
      humanStatus,
      /- evidence: artifacts\/acceptance-summary\.md \| artifacts\/browser-run\.png/,
    );
    const humanWorkflowPolicy = parseJsonBlock(humanStatus);
    const humanPrimaryAction = humanWorkflowPolicy.primaryAction;
    assertRecord(humanPrimaryAction, 'human primaryAction');
    assert.equal(humanPrimaryAction.kind, 'request_human_decision');
    const humanActor = humanPrimaryAction.actor;
    assertRecord(humanActor, 'human action actor');
    assert.equal(humanActor.type, 'human');
    assert.equal(humanWorkflowPolicy.blockingReason, 'await_human_decision');
    const humanGate = humanWorkflowPolicy.gate;
    assertRecord(humanGate, 'human gate');
    assert.equal(humanGate.status, 'blocked');
    const humanDecisionRequest = humanWorkflowPolicy.humanDecisionRequest;
    assertRecord(humanDecisionRequest, 'human decision handoff');
    const humanRecentEvents = humanWorkflowPolicy.recentEvents;
    assertArray(humanRecentEvents, 'human recent events');
    assert.equal(humanRecentEvents.length, 1);
    assertRecord(humanRecentEvents[0], 'human recent event');
    assert.equal(humanRecentEvents[0].kind, 'control_set');
    assert.equal(humanRecentEvents[0].controlKind, 'request_human_decision');
    assert.equal(
      humanDecisionRequest.blockedWithoutDecision,
      'Acceptance cannot start without an explicit product call.',
    );
    assert.equal(
      humanDecisionRequest.teamRecommendation,
      'Prefer option A and keep the current implementation direction.',
    );
    assert.equal(
      humanDecisionRequest.question,
      'Should we accept the current behavior or require a product-level change?',
    );
    assert.deepEqual(humanDecisionRequest.options, [
      'Accept current behavior',
      'Require product change before acceptance',
    ]);
    assert.deepEqual(humanDecisionRequest.evidence, [
      'artifacts/acceptance-summary.md',
      'artifacts/browser-run.png',
    ]);

    const recordHumanDecisionOutput = extractOutput(
      await recordHumanDecision(
        {
          taskDocPath: taskDocRel,
          summary: 'Human decided to keep the current behavior for this iteration.',
        },
        toolCtx,
      ),
    );
    assert.match(
      recordHumanDecisionOutput,
      /Recorded human decision for `control-case\.tsk` and cleared the active human-decision control\./,
    );

    const resolvedHumanStatus = extractOutput(
      await getStatus({ taskDocPath: taskDocRel }, toolCtx),
    );
    const resolvedHumanWorkflowPolicy = parseJsonBlock(resolvedHumanStatus);
    const resolvedHumanRecentEvents = resolvedHumanWorkflowPolicy.recentEvents;
    assertArray(resolvedHumanRecentEvents, 'resolved-human recent events');
    assert.deepEqual(
      resolvedHumanRecentEvents.map((event) => {
        assertRecord(event, 'resolved-human recent event');
        return event.kind;
      }),
      ['control_set', 'human_decision_recorded', 'control_cleared'],
    );
    const resolvedHumanLastEvent = resolvedHumanRecentEvents.at(-1);
    assertRecord(resolvedHumanLastEvent, 'resolved-human last event');
    assert.equal(resolvedHumanLastEvent.controlKind, 'request_human_decision');
    assert.equal(resolvedHumanWorkflowPolicy.blockingReason, null);

    const requestRollbackOutput = extractOutput(
      await requestRollback(
        {
          taskDocPath: taskDocRel,
          targetPhase: 'alignment',
          reason: 'Implementation assumption proved invalid.',
        },
        toolCtx,
      ),
    );
    assert.match(requestRollbackOutput, /Set rollback control/);

    const rollbackStatus = extractOutput(await getStatus({ taskDocPath: taskDocRel }, toolCtx));
    assert.match(rollbackStatus, /- primaryAction: `rollback` -> `alignment`/);
    const rollbackWorkflowPolicy = parseJsonBlock(rollbackStatus);
    const rollbackPrimaryAction = rollbackWorkflowPolicy.primaryAction;
    assertRecord(rollbackPrimaryAction, 'rollback primaryAction');
    assert.equal(rollbackPrimaryAction.kind, 'rollback');
    assert.equal(rollbackPrimaryAction.targetPhase, 'alignment');
    assert.equal(rollbackWorkflowPolicy.blockingReason, 'rollback_requested');
    const rollbackGate = rollbackWorkflowPolicy.gate;
    assertRecord(rollbackGate, 'rollback gate');
    assert.equal(rollbackGate.status, 'blocked');
    const rollbackRecentEvents = rollbackWorkflowPolicy.recentEvents;
    assertArray(rollbackRecentEvents, 'rollback recent events');
    assert.deepEqual(
      rollbackRecentEvents.map((event) => {
        assertRecord(event, 'rollback recent event');
        return event.kind;
      }),
      ['control_set', 'human_decision_recorded', 'control_cleared', 'control_set'],
    );
    const rollbackLastEvent = rollbackRecentEvents.at(-1);
    assertRecord(rollbackLastEvent, 'rollback last event');
    assert.equal(rollbackLastEvent.controlKind, 'rollback');
    assert.equal(rollbackLastEvent.targetPhase, 'alignment');

    const applyRollbackOutput = extractOutput(
      await applyRollback({ taskDocPath: taskDocRel }, toolCtx),
    );
    assert.match(
      applyRollbackOutput,
      /Rolled back `control-case\.tsk` from phase `implementation` to `alignment`\./,
    );

    const rolledBackStatus = extractOutput(await getStatus({ taskDocPath: taskDocRel }, toolCtx));
    assert.match(rolledBackStatus, /- currentPhase: `alignment` \(Alignment\)/);
    assert.match(rolledBackStatus, /phase rolled back `implementation` -> `alignment` @ /);
    const rolledBackWorkflowPolicy = parseJsonBlock(rolledBackStatus);
    const rolledBackPhase = rolledBackWorkflowPolicy.phase;
    assertRecord(rolledBackPhase, 'rolled-back phase');
    assert.equal(rolledBackPhase.id, 'alignment');
    assert.equal(rolledBackWorkflowPolicy.blockingReason, null);
    const rolledBackRecentEvents = rolledBackWorkflowPolicy.recentEvents;
    assertArray(rolledBackRecentEvents, 'rolled-back recent events');
    assert.deepEqual(
      rolledBackRecentEvents.map((event) => {
        assertRecord(event, 'rolled-back recent event');
        return event.kind;
      }),
      [
        'human_decision_recorded',
        'control_cleared',
        'control_set',
        'control_cleared',
        'phase_rolled_back',
      ],
    );

    const clearAfterRollbackOutput = extractOutput(
      await clearControl({ taskDocPath: taskDocRel }, toolCtx),
    );
    assert.match(clearAfterRollbackOutput, /No explicit phase-gate control is set/);

    const assessmentOutput = extractOutput(
      await recordAssessment(
        {
          taskDocPath: reviewTaskDocRel,
          summary: 'Implementation is ready for acceptance input check.',
          recommendation: 'approve',
        },
        toolCtx,
      ),
    );
    assert.match(
      assessmentOutput,
      /Recorded assessment for gate `acceptance_input_check` as role `builder`\./,
    );

    const assessmentStatus = extractOutput(
      await getStatus({ taskDocPath: reviewTaskDocRel }, toolCtx),
    );
    assert.match(assessmentStatus, /## Recent workflow events/);
    assert.match(
      assessmentStatus,
      /assessment recorded for `acceptance_input_check` by @owner as `builder` @ /,
    );
    const assessmentWorkflowPolicy = parseJsonBlock(assessmentStatus);
    const assessmentRecentEvents = assessmentWorkflowPolicy.recentEvents;
    assertArray(assessmentRecentEvents, 'assessment recent events');
    assert.equal(assessmentRecentEvents.length, 1);
    assertRecord(assessmentRecentEvents[0], 'assessment event');
    assert.equal(assessmentRecentEvents[0].kind, 'assessment_recorded');
    assert.equal(assessmentRecentEvents[0].recommendation, 'approve');
    assert.equal(
      assessmentRecentEvents[0].summary,
      'Implementation is ready for acceptance input check.',
    );

    const rejectedReviewOutput = extractOutput(
      await castVote(
        {
          taskDocPath: reviewTaskDocRel,
          decision: 'reject',
          rationale: 'Acceptance inputs still need one more pass.',
        },
        toolCtx,
      ),
    );
    assert.match(
      rejectedReviewOutput,
      /Recorded vote `reject` for gate `acceptance_input_check`\. Current tally: approve=0, reject=1, veto=0\./,
    );

    const rejectedReviewStatus = extractOutput(
      await getStatus({ taskDocPath: reviewTaskDocRel }, flowMentorCtx),
    );
    assert.match(rejectedReviewStatus, /- primaryAction: `dispatch_to_role` -> `builder`/);
    const rejectedReviewWorkflowPolicy = parseJsonBlock(rejectedReviewStatus);
    assert.equal(rejectedReviewWorkflowPolicy.blockingReason, 'quorum_not_met');
    const rejectedReviewUnlockBy = rejectedReviewWorkflowPolicy.unlockBy;
    assertArray(rejectedReviewUnlockBy, 'rejected-review unlockBy');
    assert.equal(rejectedReviewUnlockBy.length, 1);
    assertRecord(rejectedReviewUnlockBy[0], 'rejected-review unlock target');
    assert.equal(rejectedReviewUnlockBy[0].type, 'member');
    assert.equal(rejectedReviewUnlockBy[0].memberId, 'flow-mentor');
    assert.deepEqual(rejectedReviewUnlockBy[0].roleIds, ['flow_mentor']);
    const rejectedReviewPrimaryAction = rejectedReviewWorkflowPolicy.primaryAction;
    assertRecord(rejectedReviewPrimaryAction, 'rejected-review primaryAction');
    assert.equal(rejectedReviewPrimaryAction.kind, 'dispatch_to_role');
    assert.deepEqual(rejectedReviewPrimaryAction.targetRoleIds, ['builder']);
    const rejectedReviewTargets = rejectedReviewPrimaryAction.targetMembers;
    assertArray(rejectedReviewTargets, 'rejected-review targetMembers');
    assert.equal(rejectedReviewTargets.length, 1);
    assertRecord(rejectedReviewTargets[0], 'rejected-review target member');
    assert.equal(rejectedReviewTargets[0].memberId, 'owner');
    assert.deepEqual(rejectedReviewTargets[0].roleIds, ['builder']);

    const voteOutput = extractOutput(
      await castVote(
        {
          taskDocPath: reviewTaskDocRel,
          decision: 'approve',
          rationale: 'Acceptance inputs are ready.',
        },
        toolCtx,
      ),
    );
    assert.match(
      voteOutput,
      /Recorded vote `approve` for gate `acceptance_input_check`; quorum passed and phase advanced to `acceptance`\./,
    );

    const reviewStatus = extractOutput(await getStatus({ taskDocPath: reviewTaskDocRel }, toolCtx));
    assert.match(
      reviewStatus,
      /approve vote for `acceptance_input_check` by @owner as `builder` @ /,
    );
    assert.match(reviewStatus, /phase advanced `implementation` -> `acceptance` @ /);
    const reviewWorkflowPolicy = parseJsonBlock(reviewStatus);
    const reviewRecentEvents = reviewWorkflowPolicy.recentEvents;
    assertArray(reviewRecentEvents, 'review recent events');
    assert.deepEqual(
      reviewRecentEvents.map((event) => {
        assertRecord(event, 'review recent event');
        return event.kind;
      }),
      ['assessment_recorded', 'vote_cast', 'vote_cast', 'phase_advanced'],
    );
    const reviewPhase = reviewWorkflowPolicy.phase;
    assertRecord(reviewPhase, 'review phase');
    assert.equal(reviewPhase.id, 'acceptance');
    assert.equal(reviewWorkflowPolicy.gate, null);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
