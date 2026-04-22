import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DomindsAppRunControlHandler } from '@longrun-ai/kernel/app-host-contract';
import type { DomindsAppHostToolResult } from '@longrun-ai/kernel/app-json';
import { loadLocalAppEntry, type AppFactoryContext } from './app-entry';

export type ToolCtx = Readonly<{
  dialogId: string;
  mainDialogId: string;
  agentId: string;
  callerId: string;
}>;

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<DomindsAppHostToolResult>;

export type PhaseGateHost = Readonly<{
  tools: Readonly<Record<string, ToolHandler>>;
  runControls?: Readonly<Record<string, DomindsAppRunControlHandler>>;
}>;

type PhaseGateAppFactory = (ctx: AppFactoryContext) => Promise<PhaseGateHost>;

export type PhaseGateTools = Readonly<{
  templateList: ToolHandler;
  initFlow: ToolHandler;
  getFlow: ToolHandler;
  getBindings: ToolHandler;
  validateFlow: ToolHandler;
  replaceFlow: ToolHandler;
  replaceBindings: ToolHandler;
  getStatus: ToolHandler;
}>;

export type PhaseGateFixture = Readonly<{
  tmpRoot: string;
  taskDocRel: string;
  taskDocAbs: string;
  uninitializedTaskDocRel: string;
  bindingsTaskDocRel: string;
  bindingsTaskDocAbs: string;
  packageTemplatesDirAbs: string;
  rtwsAppDirAbs: string;
  host: PhaseGateHost;
  tools: PhaseGateTools;
  toolCtx: ToolCtx;
  cleanup: () => Promise<void>;
}>;

export function extractOutput(result: DomindsAppHostToolResult): string {
  return result.output.content;
}

export function stripFrontmatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n/m.exec(markdown);
  if (!match) {
    return markdown.trimStart();
  }
  return markdown.slice(match[0].length).trimStart();
}

export function stripBindingsBlock(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      const next = trimmed.slice(3).trim();
      if (!skipping && next === 'phasegate-bindings') {
        skipping = true;
        continue;
      }
      if (skipping && trimmed === '```') {
        skipping = false;
        continue;
      }
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();
}

export function parseJsonBlock(markdown: string): Record<string, unknown> {
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

export async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

export async function expectToolError(
  handler: ToolHandler,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string> {
  try {
    await handler(args, ctx);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected tool call to fail');
}

const existingFlowBody = [
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
  '        "participants": [',
  '          {',
  '            "roleId": "owner"',
  '          }',
  '        ]',
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
  '        "participants": [',
  '          {',
  '            "roleId": "builder"',
  '          }',
  '        ]',
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

const existingBindingsBody = [
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

const existingStateBody = [
  '```phasegate-state',
  '{',
  '  "currentPhase": "implementation",',
  '  "assessments": [',
  '    {',
  '      "gateId": "acceptance_input_check",',
  '      "memberId": "owner",',
  '      "roleId": "builder",',
  '      "summary": "Implementation inputs already look ready.",',
  '      "recommendation": "approve",',
  '      "createdAt": "2026-03-11T00:05:00.000Z"',
  '    }',
  '  ],',
  '  "votes": [],',
  '  "history": [',
  '    {',
  '      "gateId": "alignment_signoff",',
  '      "fromPhase": "alignment",',
  '      "toPhase": "implementation",',
  '      "advancedAt": "2026-03-11T00:00:00.000Z"',
  '    }',
  '  ],',
  '  "events": [',
  '    {',
  '      "kind": "phase_advanced",',
  '      "createdAt": "2026-03-11T00:00:00.000Z",',
  '      "phaseId": "implementation",',
  '      "gateId": "alignment_signoff",',
  '      "fromPhase": "alignment",',
  '      "toPhase": "implementation",',
  '      "memberId": "owner"',
  '    }',
  '  ],',
  '  "control": null',
  '}',
  '```',
  '',
].join('\n');

const invalidNoMermaidBody = [
  '```phasegate',
  '{',
  '  "version": 1,',
  '  "initialPhase": "alignment",',
  '  "roles": [',
  '    {',
  '      "id": "owner",',
  '      "title": "Owner",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    }',
  '  ],',
  '  "phases": [',
  '    {',
  '      "id": "alignment",',
  '      "gate": {',
  '        "id": "alignment_signoff",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "done"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [',
  '          {',
  '            "roleId": "owner"',
  '          }',
  '        ]',
  '      }',
  '    },',
  '    {',
  '      "id": "done"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
].join('\n');

const invalidMissingEdgeBody = [
  invalidNoMermaidBody.trimEnd(),
  '',
  '```mermaid',
  'flowchart LR',
  '  done --> alignment',
  '```',
  '',
].join('\n');

const invalidBrokenMermaidBody = [
  invalidNoMermaidBody.trimEnd(),
  '',
  '```mermaid',
  'flowchart TD',
  '  alignment[broken --> done',
  '```',
  '',
].join('\n');

const incompatiblePreserveStateBody = [
  '```phasegate',
  '{',
  '  "version": 1,',
  '  "initialPhase": "alignment",',
  '  "roles": [',
  '    {',
  '      "id": "owner",',
  '      "title": "Owner",',
  '      "toolsets": ["phase_gate_status", "phase_gate_review"]',
  '    },',
  '    {',
  '      "id": "implementer",',
  '      "title": "Implementer",',
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
  '        "participants": [',
  '          {',
  '            "roleId": "owner"',
  '          }',
  '        ]',
  '      }',
  '    },',
  '    {',
  '      "id": "implementation",',
  '      "title": "Implementation",',
  '      "gate": {',
  '        "id": "implementation_review",',
  '        "title": "Implementation review",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "acceptance"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },',
  '        "participants": [',
  '          {',
  '            "roleId": "implementer"',
  '          }',
  '        ]',
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
  '```phasegate-bindings',
  '{',
  '  "bindings": [',
  '    {',
  '      "roleId": "implementer",',
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
  '```mermaid',
  'flowchart LR',
  '  alignment --> implementation',
  '  implementation --> acceptance',
  '```',
  '',
].join('\n');

const bindingsAwareFlowBody = [
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
  '      "id": "reviewer",',
  '      "title": "Reviewer",',
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
  '        "participants": [',
  '          { "roleId": "owner" }',
  '        ]',
  '      }',
  '    },',
  '    {',
  '      "id": "implementation",',
  '      "title": "Implementation",',
  '      "gate": {',
  '        "id": "implementation_review",',
  '        "title": "Implementation review",',
  '        "exits": [',
  '          {',
  '            "id": "advance",',
  '            "trigger": "quorum_pass",',
  '            "kind": "advance",',
  '            "toPhase": "acceptance"',
  '          }',
  '        ],',
  '        "quorum": { "approveAtLeast": 2, "vetoAtMost": 0 },',
  '        "participants": [',
  '          { "roleId": "owner" },',
  '          { "roleId": "reviewer" }',
  '        ]',
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

const bindingsAwareBindingsBody = [
  '```phasegate-bindings',
  '{',
  '  "bindings": [',
  '    {',
  '      "roleId": "owner",',
  '      "memberIds": ["@owner"]',
  '    },',
  '    {',
  '      "roleId": "reviewer",',
  '      "memberIds": ["@reviewer-a", "@reviewer-b"]',
  '    }',
  '  ]',
  '}',
  '```',
  '',
].join('\n');

export const existingFlowMarkdown = ['# Existing Flow', '', existingFlowBody].join('\n');

export const existingBindingsMarkdown = ['# Phase Gate Bindings', '', existingBindingsBody].join(
  '\n',
);

export const existingStateMarkdown = ['# Phase Gate State', '', existingStateBody].join('\n');

export const invalidNoMermaidFlow = ['# Invalid Flow', '', invalidNoMermaidBody].join('\n');

export const invalidMissingEdgeFlow = ['# Invalid Flow', '', invalidMissingEdgeBody].join('\n');

export const invalidBrokenMermaidFlow = ['# Invalid Flow', '', invalidBrokenMermaidBody].join('\n');

export const incompatiblePreserveStateFlow = [
  '# Incompatible Flow',
  '',
  incompatiblePreserveStateBody,
].join('\n');

export const bindingsAwareFlow = ['# Bindings-aware Flow', '', bindingsAwareFlowBody].join('\n');

export const bindingsAwareBindings = ['# Phase Gate Bindings', '', bindingsAwareBindingsBody].join(
  '\n',
);

export function resolvePhaseGateFixture(markdown: string): string {
  return markdown;
}

export async function createPhaseGateFixture(): Promise<PhaseGateFixture> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-phase-gate-flow-'));
  const taskDocRel = 'manage-case.tsk';
  const taskDocAbs = path.join(tmpRoot, taskDocRel);
  const uninitializedTaskDocRel = 'uninitialized-case.tsk';
  const bindingsTaskDocRel = 'bindings-case.tsk';
  const bindingsTaskDocAbs = path.join(tmpRoot, bindingsTaskDocRel);
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
  const packageTemplatesDirAbs = path.join(packageRootAbs, 'templates');

  await writeText(
    path.join(taskDocAbs, 'phasegate', 'flow.md'),
    resolvePhaseGateFixture(existingFlowMarkdown),
  );
  await writeText(
    path.join(taskDocAbs, 'phasegate', 'bindings.md'),
    resolvePhaseGateFixture(existingBindingsMarkdown),
  );
  await writeText(
    path.join(taskDocAbs, 'phasegate', 'state.md'),
    resolvePhaseGateFixture(existingStateMarkdown),
  );
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
    taskDocRel,
    taskDocAbs,
    uninitializedTaskDocRel,
    bindingsTaskDocRel,
    bindingsTaskDocAbs,
    packageTemplatesDirAbs,
    rtwsAppDirAbs,
    host,
    tools: getPhaseGateTools(host),
    toolCtx: {
      dialogId: 'dlg-owner',
      mainDialogId: 'root-owner',
      agentId: 'owner',
      callerId: '@owner',
    },
    cleanup: async () => {
      process.chdir(previousCwd);
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

function getPhaseGateTools(host: PhaseGateHost): PhaseGateTools {
  const templateList = host.tools.phase_gate_template_list;
  assert.ok(templateList, 'expected phase_gate_template_list tool');
  const initFlow = host.tools.phase_gate_init_flow;
  assert.ok(initFlow, 'expected phase_gate_init_flow tool');
  const getFlow = host.tools.phase_gate_get_flow;
  assert.ok(getFlow, 'expected phase_gate_get_flow tool');
  const getBindings = host.tools.phase_gate_get_bindings;
  assert.ok(getBindings, 'expected phase_gate_get_bindings tool');
  const validateFlow = host.tools.phase_gate_validate_flow;
  assert.ok(validateFlow, 'expected phase_gate_validate_flow tool');
  const replaceFlow = host.tools.phase_gate_replace_flow;
  assert.ok(replaceFlow, 'expected phase_gate_replace_flow tool');
  const replaceBindings = host.tools.phase_gate_replace_bindings;
  assert.ok(replaceBindings, 'expected phase_gate_replace_bindings tool');
  const getStatus = host.tools.phase_gate_get_status;
  assert.ok(getStatus, 'expected phase_gate_get_status tool');
  return {
    templateList,
    initFlow,
    getFlow,
    getBindings,
    validateFlow,
    replaceFlow,
    replaceBindings,
    getStatus,
  };
}
