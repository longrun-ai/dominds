import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DomindsAppRunControlHandler } from '@longrun-ai/kernel/app-host-contract';
import { loadLocalAppEntry, type AppFactoryContext } from './app-entry';
import { extractOutput, parseJsonBlock, writeText, type ToolCtx } from './phase-gate-flow-fixture';

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<string | Readonly<{ output: string }>>;

type PhaseGateHost = Readonly<{
  tools: Readonly<Record<string, ToolHandler>>;
  runControls?: Readonly<Record<string, DomindsAppRunControlHandler>>;
}>;

type PhaseGateAppFactory = (ctx: AppFactoryContext) => Promise<PhaseGateHost>;

export type PhaseGatePrimaryActionTools = Readonly<{
  requestHumanDecision: ToolHandler;
  getStatus: ToolHandler;
  clearControl: ToolHandler;
  requestRollback: ToolHandler;
  recordHumanDecision: ToolHandler;
  applyRollback: ToolHandler;
  selectExit: ToolHandler;
  recordAssessment: ToolHandler;
  castVote: ToolHandler;
}>;

export type PhaseGatePrimaryActionsFixture = Readonly<{
  tmpRoot: string;
  controlTaskDocRel: string;
  reviewTaskDocRel: string;
  manualTaskDocRel: string;
  vetoTaskDocRel: string;
  host: PhaseGateHost;
  tools: PhaseGatePrimaryActionTools;
  ownerCtx: ToolCtx;
  flowMentorCtx: ToolCtx;
  cleanup: () => Promise<void>;
}>;

export function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

export function assertArray(value: unknown, label: string): asserts value is unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
}

export function parsePhaseGateStateBlock(markdown: string): Record<string, unknown> {
  const match = /```phasegate-state\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match, 'expected phase-gate state markdown to include a JSON block');
  const raw = match[1];
  assert.ok(raw, 'expected phase-gate state JSON payload');
  const parsed: unknown = JSON.parse(raw);
  assertRecord(parsed, 'phase-gate state');
  return parsed;
}

const sharedBindingsBody = [
  '```phasegate-bindings',
  '{',
  '  "bindings": [',
  '    {',
  '      "roleId": "builder",',
  '      "memberIds": ["@owner"]',
  '    },',
  '    {',
  '      "roleId": "owner",',
  '      "memberIds": ["@owner"]',
  '    }',
  '  ]',
  '}',
  '```',
  '',
].join('\n');

const reviewFlowBody = [
  '```phasegate',
  '{',
  '  "version": 1,',
  '  "flowMentor": {',
  '    "memberId": "@flow-mentor",',
  '    "toolsets": ["phase_gate_status", "phase_gate_manage"]',
  '  },',
  '  "initialPhase": "alignment",',
  '  "roles": [',
  '    {',
  '      "id": "owner",',
  '      "title": "Owner",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    },',
  '    {',
  '      "id": "builder",',
  '      "title": "Builder",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    }',
  '  ],',
  '  "phases": [',
  '    {',
  '      "id": "alignment",',
  '      "title": "Alignment",',
  '      "gate": {',
  '        "id": "alignment_signoff",',
  '        "title": "Alignment sign-off",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "implementation"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "owner" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "implementation",',
  '      "title": "Implementation",',
  '      "gate": {',
  '        "id": "acceptance_input_check",',
  '        "title": "Acceptance input check",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "acceptance"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "builder" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "acceptance",',
  '      "title": "Acceptance"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  alignment --> implementation',
  '  implementation --> acceptance',
  '```',
  '',
].join('\n');

const controlFlowBody = [
  '```phasegate',
  '{',
  '  "version": 1,',
  '  "flowMentor": {',
  '    "memberId": "@flow-mentor",',
  '    "toolsets": ["phase_gate_status", "phase_gate_manage"]',
  '  },',
  '  "initialPhase": "alignment",',
  '  "roles": [',
  '    {',
  '      "id": "owner",',
  '      "title": "Owner",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    },',
  '    {',
  '      "id": "builder",',
  '      "title": "Builder",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    }',
  '  ],',
  '  "phases": [',
  '    {',
  '      "id": "alignment",',
  '      "title": "Alignment",',
  '      "gate": {',
  '        "id": "alignment_signoff",',
  '        "title": "Alignment sign-off",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "implementation"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "owner" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "implementation",',
  '      "title": "Implementation",',
  '      "gate": {',
  '        "id": "acceptance_input_check",',
  '        "title": "Acceptance input check",',
  '        "exits": [',
  '          {',
  '            "id": "revisit_alignment",',
  '            "title": "Revisit alignment",',
  '            "kind": "rollback",',
  '            "trigger": "manual",',
  '            "toPhase": "alignment"',
  '          },',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "acceptance"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "builder" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "acceptance",',
  '      "title": "Acceptance"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  alignment --> implementation',
  '  implementation --> acceptance',
  '  implementation --> alignment',
  '```',
  '',
].join('\n');

const manualFlowBody = [
  '```phasegate',
  '{',
  '  "version": 1,',
  '  "flowMentor": {',
  '    "memberId": "@flow-mentor",',
  '    "toolsets": ["phase_gate_status", "phase_gate_manage"]',
  '  },',
  '  "initialPhase": "triage",',
  '  "roles": [',
  '    {',
  '      "id": "owner",',
  '      "title": "Owner",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    },',
  '    {',
  '      "id": "builder",',
  '      "title": "Builder",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    }',
  '  ],',
  '  "phases": [',
  '    {',
  '      "id": "triage",',
  '      "title": "Triage",',
  '      "gate": {',
  '        "id": "classify_change",',
  '        "title": "Classify change",',
  '        "exits": [',
  '          {',
  '            "id": "small_change_path",',
  '            "title": "Small change path",',
  '            "kind": "classification",',
  '            "trigger": "quorum_pass",',
  '            "toPhase": "implementation"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "owner" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "implementation",',
  '      "title": "Implementation",',
  '      "gate": {',
  '        "id": "implementation_signoff",',
  '        "title": "Implementation sign-off",',
  '        "exits": [',
  '          {',
  '            "id": "ship_small_change",',
  '            "title": "Ship small change",',
  '            "kind": "path",',
  '            "trigger": "manual",',
  '            "toPhase": "acceptance"',
  '          },',
  '          {',
  '            "id": "escalate_committee",',
  '            "title": "Escalate to expert committee",',
  '            "label": "Expert committee",',
  '            "kind": "escalate",',
  '            "trigger": "manual",',
  '            "toPhase": "committee_review"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [{ "roleId": "builder" }]',
  '      }',
  '    },',
  '    {',
  '      "id": "committee_review",',
  '      "title": "Committee Review"',
  '    },',
  '    {',
  '      "id": "acceptance",',
  '      "title": "Acceptance"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  triage --> implementation',
  '  implementation --> acceptance',
  '  implementation --> committee_review',
  '```',
  '',
].join('\n');

const standardStateBody = [
  '```phasegate-state',
  '{',
  '  "currentPhase": "implementation",',
  '  "assessments": [],',
  '  "votes": [],',
  '  "history": [',
  '    {',
  '      "gateId": "alignment_signoff",',
  '      "fromPhase": "alignment",',
  '      "toPhase": "implementation",',
  '      "exitId": "advance",',
  '      "exitKind": "advance",',
  '      "advancedAt": "2026-03-11T00:00:00.000Z"',
  '    }',
  '  ],',
  '  "control": null',
  '}',
  '```',
  '',
].join('\n');

const manualStateBody = [
  '```phasegate-state',
  '{',
  '  "currentPhase": "implementation",',
  '  "assessments": [],',
  '  "votes": [],',
  '  "history": [',
  '    {',
  '      "gateId": "classify_change",',
  '      "fromPhase": "triage",',
  '      "toPhase": "implementation",',
  '      "exitId": "small_change_path",',
  '      "exitKind": "classification",',
  '      "advancedAt": "2026-03-11T00:00:00.000Z"',
  '    }',
  '  ],',
  '  "events": [',
  '    {',
  '      "kind": "phase_advanced",',
  '      "createdAt": "2026-03-11T00:00:00.000Z",',
  '      "phaseId": "implementation",',
  '      "gateId": "classify_change",',
  '      "fromPhase": "triage",',
  '      "toPhase": "implementation",',
  '      "exitId": "small_change_path",',
  '      "exitKind": "classification",',
  '      "memberId": "owner"',
  '    }',
  '  ],',
  '  "control": null',
  '}',
  '```',
  '',
].join('\n');

const sharedBindingsMarkdown = ['# Phase Gate Bindings', '', sharedBindingsBody].join('\n');

const reviewFlowMarkdown = ['# Phase Gate Flow', '', reviewFlowBody].join('\n');

const controlFlowMarkdown = ['# Phase Gate Flow', '', controlFlowBody].join('\n');

const manualFlowMarkdown = ['# Phase Gate Flow', '', manualFlowBody].join('\n');

const standardStateMarkdown = ['# Phase Gate State', '', standardStateBody].join('\n');

const manualStateMarkdown = ['# Phase Gate State', '', manualStateBody].join('\n');

async function writeTaskdoc(
  taskDocAbs: string,
  params: Readonly<{ flow: string; bindings: string; state: string }>,
): Promise<void> {
  await writeText(path.join(taskDocAbs, 'phasegate', 'flow.md'), params.flow);
  await writeText(path.join(taskDocAbs, 'phasegate', 'bindings.md'), params.bindings);
  await writeText(path.join(taskDocAbs, 'phasegate', 'state.md'), params.state);
}

export async function createPhaseGatePrimaryActionsFixture(): Promise<PhaseGatePrimaryActionsFixture> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-phase-gate-primary-actions-'));
  const controlTaskDocRel = 'control-case.tsk';
  const reviewTaskDocRel = 'review-case.tsk';
  const manualTaskDocRel = 'manual-case.tsk';
  const vetoTaskDocRel = 'veto-case.tsk';
  const packageRootAbs = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'dominds-apps',
    '@longrun-ai',
    'phase-gate',
  );
  const rtwsAppDirAbs = path.join(tmpRoot, '.apps', '@longrun-ai', 'phase-gate');

  await writeTaskdoc(path.join(tmpRoot, controlTaskDocRel), {
    flow: controlFlowMarkdown,
    bindings: sharedBindingsMarkdown,
    state: standardStateMarkdown,
  });
  await writeTaskdoc(path.join(tmpRoot, reviewTaskDocRel), {
    flow: reviewFlowMarkdown,
    bindings: sharedBindingsMarkdown,
    state: standardStateMarkdown,
  });
  await writeTaskdoc(path.join(tmpRoot, manualTaskDocRel), {
    flow: manualFlowMarkdown,
    bindings: sharedBindingsMarkdown,
    state: manualStateMarkdown,
  });
  await writeTaskdoc(path.join(tmpRoot, vetoTaskDocRel), {
    flow: reviewFlowMarkdown,
    bindings: sharedBindingsMarkdown,
    state: standardStateMarkdown,
  });
  process.chdir(tmpRoot);

  const { appFactory } = await loadLocalAppEntry({ packageRootAbs });
  const host = await (appFactory as unknown as PhaseGateAppFactory)({
    appId: '@longrun-ai/phase-gate',
    rtwsRootAbs: tmpRoot,
    rtwsAppDirAbs,
    packageRootAbs,
    kernel: { host: '127.0.0.1', port: 0 },
    log: () => undefined,
  });

  return {
    tmpRoot,
    controlTaskDocRel,
    reviewTaskDocRel,
    manualTaskDocRel,
    vetoTaskDocRel,
    host,
    tools: getPrimaryActionTools(host),
    ownerCtx: {
      dialogId: 'dlg-owner',
      rootDialogId: 'root-owner',
      agentId: 'owner',
      callerId: '@owner',
    },
    flowMentorCtx: {
      dialogId: 'dlg-flow-mentor',
      rootDialogId: 'root-flow-mentor',
      agentId: 'flow-mentor',
      callerId: '@flow-mentor',
    },
    cleanup: async () => {
      process.chdir(previousCwd);
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

function getPrimaryActionTools(host: PhaseGateHost): PhaseGatePrimaryActionTools {
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
  const selectExit = host.tools.phase_gate_select_exit;
  assert.ok(selectExit, 'expected phase_gate_select_exit tool');
  const recordAssessment = host.tools.phase_gate_record_assessment;
  assert.ok(recordAssessment, 'expected phase_gate_record_assessment tool');
  const castVote = host.tools.phase_gate_cast_vote;
  assert.ok(castVote, 'expected phase_gate_cast_vote tool');
  return {
    requestHumanDecision,
    getStatus,
    clearControl,
    requestRollback,
    recordHumanDecision,
    applyRollback,
    selectExit,
    recordAssessment,
    castVote,
  };
}

export { extractOutput, parseJsonBlock };
