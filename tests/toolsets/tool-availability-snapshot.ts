#!/usr/bin/env tsx

import '../../main/tools/builtins';

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createToolAvailabilitySnapshot } from '../../main/tool-availability';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

function toolNames(
  snapshot: Awaited<ReturnType<typeof createToolAvailabilitySnapshot>>,
): Set<string> {
  return new Set([
    ...snapshot.composition.visibleStandaloneTools.map((tool) => tool.name),
    ...snapshot.composition.visibleToolsets.flatMap((toolset) =>
      toolset.tools.map((tool) => tool.name),
    ),
  ]);
}

function toolsetByName(
  snapshot: Awaited<ReturnType<typeof createToolAvailabilitySnapshot>>,
  name: string,
) {
  return snapshot.composition.visibleToolsets.find((toolset) => toolset.name === name);
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-tool-availability-'));

  try {
    process.chdir(tmpRoot);
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'default_responder: ux',
        'shell_specialists:',
        '  - cmdr',
        'members:',
        '  ux:',
        '    name: UX',
        '    toolsets:',
        '      - "*"',
        '      - "!os"',
        '  direct:',
        '    name: Direct',
        '    tools:',
        '      - shell_cmd',
        '      - list_resources',
        '  cmdr:',
        '    name: Commander',
        '    toolsets:',
        '      - os',
        '',
      ].join('\n'),
    );

    const uxMain = await createToolAvailabilitySnapshot({
      agentId: 'ux',
      dialog: { rootId: 'root', selfId: 'root' },
    });
    const uxMainNames = toolNames(uxMain);
    assert.ok(uxMainNames.has('man'), 'main snapshot should include the manual tool');
    assert.ok(uxMainNames.has('read_skill'), 'main snapshot should include read_skill');
    assert.ok(uxMainNames.has('list_resources'), 'resources toolset should expose list_resources');
    assert.ok(uxMainNames.has('do_mind'), 'main dialog should include taskdoc mutation tools');
    assert.ok(!uxMainNames.has('shell_cmd'), 'non-shell specialist should not see shell_cmd');

    const uxSide = await createToolAvailabilitySnapshot({
      agentId: 'ux',
      dialog: { rootId: 'root', selfId: 'side' },
    });
    const uxSideNames = toolNames(uxSide);
    assert.ok(uxSideNames.has('add_reminder'), 'side dialog should keep reminder control tools');
    assert.ok(!uxSideNames.has('do_mind'), 'side dialog should hide taskdoc mutation tools');

    const direct = await createToolAvailabilitySnapshot({
      agentId: 'direct',
      dialog: { rootId: 'root2', selfId: 'root2' },
    });
    const standaloneToolNames = new Set(
      direct.composition.visibleStandaloneTools.map((tool) => tool.name),
    );
    assert.deepEqual(standaloneToolNames, new Set(['list_resources', 'man', 'read_skill']));

    const cmdr = await createToolAvailabilitySnapshot({
      agentId: 'cmdr',
      dialog: { rootId: 'root3', selfId: 'root3' },
    });
    const cmdrOs = toolsetByName(cmdr, 'os');
    assert.ok(cmdrOs, 'shell specialist should see os toolset');
    assert.ok(
      cmdrOs.tools.some((tool) => tool.name === 'shell_cmd'),
      'shell specialist os toolset should include shell_cmd',
    );
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
