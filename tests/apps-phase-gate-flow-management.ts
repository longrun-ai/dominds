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

function stripFrontmatter(markdown: string): string {
  const match = /^---\n[\s\S]*?\n---\n/m.exec(markdown);
  if (!match) {
    return markdown.trimStart();
  }
  return markdown.slice(match[0].length).trimStart();
}

function stripBindingsBlock(markdown: string): string {
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

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function expectToolError(
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

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-phase-gate-flow-management-'));
  const taskDocRel = 'manage-case.tsk';
  const taskDocAbs = path.join(tmpRoot, taskDocRel);
  const uninitializedTaskDocRel = 'uninitialized-case.tsk';
  const bindingsTaskDocRel = 'bindings-case.tsk';
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
  const packageTemplatesDirAbs = path.join(packageRootAbs, 'templates');

  const flowMarkdown = `# Existing Flow

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
  "assessments": [
    {
      "gateId": "acceptance_input_check",
      "memberId": "owner",
      "roleId": "builder",
      "summary": "Implementation inputs already look ready.",
      "recommendation": "approve",
      "createdAt": "2026-03-11T00:05:00.000Z"
    }
  ],
  "votes": [],
  "history": [
    {
      "gateId": "alignment_signoff",
      "fromPhase": "alignment",
      "toPhase": "implementation",
      "advancedAt": "2026-03-11T00:00:00.000Z"
    }
  ],
  "events": [
    {
      "kind": "phase_advanced",
      "createdAt": "2026-03-11T00:00:00.000Z",
      "phaseId": "implementation",
      "gateId": "alignment_signoff",
      "fromPhase": "alignment",
      "toPhase": "implementation",
      "memberId": "owner"
    }
  ],
  "control": null
}
\`\`\`
`;

  const invalidNoMermaidFlow = `# Invalid Flow

\`\`\`phasegate
{
  "version": 1,
  "initialPhase": "alignment",
  "phases": [
    {
      "id": "alignment",
      "gate": {
        "id": "alignment_signoff",
        "toPhase": "done",
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
      "id": "done"
    }
  ]
}
\`\`\`
`;

  const invalidMissingEdgeFlow = `# Invalid Flow

\`\`\`phasegate
{
  "version": 1,
  "initialPhase": "alignment",
  "phases": [
    {
      "id": "alignment",
      "gate": {
        "id": "alignment_signoff",
        "toPhase": "done",
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
      "id": "done"
    }
  ]
}
\`\`\`

\`\`\`mermaid
flowchart LR
  done --> alignment
\`\`\`
`;

  const incompatiblePreserveStateFlow = `# Incompatible Flow

\`\`\`phasegate
{
  "version": 1,
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
        "id": "implementation_review",
        "title": "Implementation review",
        "toPhase": "acceptance",
        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },
        "roles": [
          {
            "id": "implementer",
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

  const bindingsAwareFlow = `# Bindings-aware Flow

\`\`\`phasegate
{
  "version": 1,
  "flowMentor": {
    "memberId": "@flow-mentor",
    "toolsets": ["phase_gate_status", "phase_gate_manage"]
  },
  "initialPhase": "alignment",
  "roles": [
    {
      "id": "owner",
      "title": "Owner",
      "toolsets": ["phase_gate_status", "phase_gate_review"]
    },
    {
      "id": "reviewer",
      "title": "Reviewer",
      "toolsets": ["phase_gate_status", "phase_gate_review"]
    }
  ],
  "phases": [
    {
      "id": "alignment",
      "title": "Alignment",
      "gate": {
        "id": "alignment_signoff",
        "title": "Alignment sign-off",
        "toPhase": "implementation",
        "quorum": { "approveAtLeast": 1, "vetoAtMost": 0 },
        "participants": [
          { "roleId": "owner" }
        ]
      }
    },
    {
      "id": "implementation",
      "title": "Implementation",
      "gate": {
        "id": "implementation_review",
        "title": "Implementation review",
        "toPhase": "acceptance",
        "quorum": { "approveAtLeast": 2, "vetoAtMost": 0 },
        "participants": [
          { "roleId": "owner" },
          { "roleId": "reviewer" }
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

  const bindingsAwareBindings = `# Phase Gate Bindings

\`\`\`phasegate-bindings
{
  "bindings": [
    {
      "roleId": "owner",
      "memberIds": ["@owner"]
    },
    {
      "roleId": "reviewer",
      "memberIds": ["@reviewer-a", "@reviewer-b"]
    }
  ]
}
\`\`\`
`;

  try {
    process.chdir(tmpRoot);
    await writeText(path.join(taskDocAbs, 'phasegate', 'flow.md'), flowMarkdown);
    await writeText(path.join(taskDocAbs, 'phasegate', 'state.md'), stateMarkdown);

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

    const templateList = host.tools.phase_gate_template_list;
    assert.ok(templateList, 'expected phase_gate_template_list tool');
    const initFlow = host.tools.phase_gate_init_flow;
    assert.ok(initFlow, 'expected phase_gate_init_flow tool');
    const getFlow = host.tools.phase_gate_get_flow;
    assert.ok(getFlow, 'expected phase_gate_get_flow tool');
    const getBindings = host.tools.phase_gate_get_bindings;
    assert.ok(getBindings, 'expected phase_gate_get_bindings tool');
    const replaceFlow = host.tools.phase_gate_replace_flow;
    assert.ok(replaceFlow, 'expected phase_gate_replace_flow tool');
    const replaceBindings = host.tools.phase_gate_replace_bindings;
    assert.ok(replaceBindings, 'expected phase_gate_replace_bindings tool');
    const getStatus = host.tools.phase_gate_get_status;
    assert.ok(getStatus, 'expected phase_gate_get_status tool');

    const templateListOutput = extractOutput(await templateList({}, toolCtx));
    assert.match(templateListOutput, /`mvp_default`/);
    assert.match(templateListOutput, /`web_dev_acceptance`/);

    const packageTemplateFileNames = (await fs.readdir(packageTemplatesDirAbs))
      .filter((entry) => entry.endsWith('.flow.md'))
      .sort();
    assert.deepEqual(packageTemplateFileNames, [
      'mvp_default.flow.md',
      'web_dev_acceptance.flow.md',
    ]);

    const packageTemplateFrontmatters = await Promise.all(
      packageTemplateFileNames.map(async (fileName) => {
        const raw = await fs.readFile(path.join(packageTemplatesDirAbs, fileName), 'utf-8');
        const match = /^---\n([\s\S]*?)\n---\n/m.exec(raw);
        assert.ok(match, `expected template ${fileName} to start with frontmatter`);
        const frontmatter = match[1] ?? '';
        const idMatch = /^id:\s*(.+)$/m.exec(frontmatter);
        assert.ok(idMatch, `expected template ${fileName} frontmatter to declare id`);
        const descriptionMatch = /^description:\s*(.+)$/m.exec(frontmatter);
        assert.ok(
          descriptionMatch,
          `expected template ${fileName} frontmatter to declare description`,
        );
        return idMatch[1]?.trim();
      }),
    );
    const packageTemplateIds = packageTemplateFrontmatters.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    assert.deepEqual(packageTemplateIds, ['mvp_default', 'web_dev_acceptance']);

    const initOutput = extractOutput(
      await initFlow(
        {
          taskDocPath: taskDocRel,
          templateId: 'mvp_default',
          overwrite: true,
          resetState: false,
        },
        toolCtx,
      ),
    );
    assert.match(
      initOutput,
      /Initialized phase-gate template `mvp_default` for `manage-case\.tsk`\./,
    );

    const packagedMvpTemplate = await fs.readFile(
      path.join(packageTemplatesDirAbs, 'mvp_default.flow.md'),
      'utf-8',
    );
    const packagedMvpTemplateBody = stripFrontmatter(packagedMvpTemplate);
    const packagedMvpFlowBody = stripBindingsBlock(packagedMvpTemplateBody);
    const mirroredMvpTemplate = await fs.readFile(
      path.join(rtwsAppDirAbs, 'templates', 'mvp_default.flow.md'),
      'utf-8',
    );
    const initializedFlowMarkdown = await fs.readFile(
      path.join(taskDocAbs, 'phasegate', 'flow.md'),
      'utf-8',
    );
    const initializedBindingsMarkdown = await fs.readFile(
      path.join(taskDocAbs, 'phasegate', 'bindings.md'),
      'utf-8',
    );
    assert.doesNotMatch(initializedFlowMarkdown, /^---$/m);
    assert.match(mirroredMvpTemplate, /```phasegate-bindings/);
    assert.doesNotMatch(initializedFlowMarkdown, /```phasegate-bindings/);
    assert.equal(mirroredMvpTemplate, packagedMvpTemplateBody);
    assert.equal(initializedFlowMarkdown, packagedMvpFlowBody);
    assert.match(initializedBindingsMarkdown, /"roleId": "owner"/);

    const currentFlowOutput = extractOutput(await getFlow({ taskDocPath: taskDocRel }, toolCtx));
    assert.match(currentFlowOutput, /^# Current phase-gate flow/m);
    assert.match(currentFlowOutput, /Taskdoc: `manage-case\.tsk`/);
    assert.match(currentFlowOutput, /```phasegate/);
    assert.match(currentFlowOutput, /"participants": \[/);
    assert.match(currentFlowOutput, /"id": "browser_regression"/);

    const legacyBindingsOutput = extractOutput(
      await getBindings({ taskDocPath: taskDocRel }, toolCtx),
    );
    assert.match(legacyBindingsOutput, /^# Current phase-gate bindings/m);
    assert.match(legacyBindingsOutput, /- bindingsSource: `file`/);
    assert.match(legacyBindingsOutput, /"roleId": "builder"/);
    assert.match(legacyBindingsOutput, /@owner/);

    const preservedStatus = extractOutput(await getStatus({ taskDocPath: taskDocRel }, toolCtx));
    assert.match(preservedStatus, /- currentPhase: `implementation` \(Implementation\)/);
    const preservedWorkflowPolicy = parseJsonBlock(preservedStatus);
    const preservedPhase = preservedWorkflowPolicy.phase;
    assert.equal(typeof preservedPhase, 'object');
    assert.notEqual(preservedPhase, null);
    assert.equal(Array.isArray(preservedPhase), false);
    assert.equal((preservedPhase as Record<string, unknown>).id, 'implementation');
    const preservedRecentEvents = preservedWorkflowPolicy.recentEvents;
    assert.ok(Array.isArray(preservedRecentEvents), 'expected recentEvents array');
    assert.equal(preservedRecentEvents.length, 1);

    const incompatibleReplaceMessage = await expectToolError(
      replaceFlow,
      {
        taskDocPath: taskDocRel,
        content: incompatiblePreserveStateFlow,
      },
      toolCtx,
    );
    assert.match(
      incompatibleReplaceMessage,
      /state\.assessments\[0\]\.gateId 'acceptance_input_check' is not declared in the flow/,
    );

    const incompatibleInitMessage = await expectToolError(
      initFlow,
      {
        taskDocPath: taskDocRel,
        templateId: 'web_dev_acceptance',
        overwrite: true,
        resetState: false,
      },
      toolCtx,
    );
    assert.match(
      incompatibleInitMessage,
      /state\.assessments\[0\]\.roleId 'builder' is not declared for gate 'acceptance_input_check'/,
    );

    const missingFlowMessage = await expectToolError(
      getFlow,
      {
        taskDocPath: uninitializedTaskDocRel,
      },
      toolCtx,
    );
    assert.match(
      missingFlowMessage,
      /phase-gate flow is not initialized for 'uninitialized-case\.tsk'; use 'phase_gate_init_flow' first/,
    );

    const invalidNoMermaidMessage = await expectToolError(
      replaceFlow,
      {
        taskDocPath: taskDocRel,
        content: invalidNoMermaidFlow,
      },
      toolCtx,
    );
    assert.match(invalidNoMermaidMessage, /flow markdown must include a ```mermaid block/);

    const invalidMissingEdgeMessage = await expectToolError(
      replaceFlow,
      {
        taskDocPath: taskDocRel,
        content: invalidMissingEdgeFlow,
      },
      toolCtx,
    );
    assert.match(invalidMissingEdgeMessage, /mermaid graph is missing edge 'alignment->done'/);

    const statusAfterFailures = extractOutput(
      await getStatus({ taskDocPath: taskDocRel }, toolCtx),
    );
    assert.match(statusAfterFailures, /- currentPhase: `implementation` \(Implementation\)/);
    assert.match(
      statusAfterFailures,
      /- activeGate: `acceptance_input_check` \(Acceptance input check\)/,
    );

    const replacedBindingsAwareFlow = extractOutput(
      await replaceFlow(
        {
          taskDocPath: bindingsTaskDocRel,
          content: bindingsAwareFlow,
          resetState: true,
        },
        toolCtx,
      ),
    );
    assert.match(
      replacedBindingsAwareFlow,
      /Replaced phase-gate flow for `bindings-case\.tsk` and reset state\./,
    );

    const initialBindingsOutput = extractOutput(
      await getBindings({ taskDocPath: bindingsTaskDocRel }, toolCtx),
    );
    assert.match(initialBindingsOutput, /- bindingsSource: `file`/);
    assert.match(initialBindingsOutput, /"roleId": "owner"/);
    assert.match(initialBindingsOutput, /"roleId": "reviewer"/);

    const statusWithMissingBindings = extractOutput(
      await getStatus({ taskDocPath: bindingsTaskDocRel }, toolCtx),
    );
    assert.match(statusWithMissingBindings, /- blockingReason: `missing_bindings`/);
    assert.match(statusWithMissingBindings, /- missingBindings: `owner`/);
    const missingBindingsPolicy = parseJsonBlock(statusWithMissingBindings);
    assert.equal(missingBindingsPolicy.blockingReason, 'missing_bindings');

    const replacedBindingsOutput = extractOutput(
      await replaceBindings(
        {
          taskDocPath: bindingsTaskDocRel,
          content: bindingsAwareBindings,
        },
        toolCtx,
      ),
    );
    assert.match(replacedBindingsOutput, /Replaced phase-gate bindings for `bindings-case\.tsk`\./);

    const currentBindingsOutput = extractOutput(
      await getBindings({ taskDocPath: bindingsTaskDocRel }, toolCtx),
    );
    assert.match(currentBindingsOutput, /"memberIds": \[/);
    assert.match(currentBindingsOutput, /@reviewer-a/);
    assert.match(currentBindingsOutput, /@reviewer-b/);

    const statusAfterBindings = extractOutput(
      await getStatus({ taskDocPath: bindingsTaskDocRel }, toolCtx),
    );
    assert.doesNotMatch(statusAfterBindings, /- missingBindings:/);
    assert.match(statusAfterBindings, /- activeRolesNow: `owner`/);
    const bindingsWorkflowPolicy = parseJsonBlock(statusAfterBindings);
    const bindingsMeta = bindingsWorkflowPolicy.bindings;
    assert.equal(typeof bindingsMeta, 'object');
    assert.notEqual(bindingsMeta, null);
    assert.equal((bindingsMeta as Record<string, unknown>).source, 'file');
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
