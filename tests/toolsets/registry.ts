#!/usr/bin/env tsx

import '../../main/tools/builtins';

import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';
import { getTool, getToolset, listTools, listToolsets } from '../../main/tools/registry';

// Helper function to run a test case
async function runTest(name: string, testFn: () => void | Promise<void>): Promise<void> {
  console.log(`\n=== Testing: ${name} ===`);

  try {
    await testFn();
    console.log(`✅ PASS`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ FAIL: ${message}`);
    process.exit(1);
  }
}

// Helper function to assert equality
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// Helper function to assert truthy
function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

async function main(): Promise<void> {
  // Test 1: Registry functions availability
  await runTest('Registry functions availability', () => {
    const toolsets = listToolsets();
    const tools = listTools();

    assertTrue(Object.keys(toolsets).length > 0, 'Should have registered toolsets');
    assertTrue(tools.length > 0, 'Should have registered tools');

    console.log(`Available toolsets: ${Object.keys(toolsets).join(', ')}`);
    console.log(`Available tools count: ${tools.length}`);
  });

  // Test 2: Toolset lookup returns Tool objects
  await runTest('Toolset lookup returns Tool objects', () => {
    const wsReadToolset = getToolset('ws_read');
    const personalMemoryToolset = getToolset('personal_memory');
    const sharedMemoryToolset = getToolset('team_memory');
    const nonexistentToolset = getToolset('nonexistent');

    assertTrue(Array.isArray(wsReadToolset), 'ws_read toolset should be an array');
    assertTrue(Array.isArray(personalMemoryToolset), 'personal_memory toolset should be an array');
    assertTrue(Array.isArray(sharedMemoryToolset), 'team_memory toolset should be an array');
    assertEqual(nonexistentToolset, undefined, 'nonexistent toolset should be undefined');

    // Verify tools are actual Tool objects
    if (wsReadToolset) {
      for (const tool of wsReadToolset) {
        assertTrue(typeof tool === 'object' && 'name' in tool, 'Each item should be a Tool object');
      }
      console.log(`ws_read toolset tools: ${wsReadToolset.map((t) => t.name).join(', ')}`);
    }
  });

  // Test 3: Individual tool lookup
  await runTest('Individual tool lookup', () => {
    const listDirTool = getTool('list_dir');
    const readFileTool = getTool('read_file');
    const readPictureTool = getTool('read_picture');
    const writePictureTool = getTool('write_picture');
    const addPersonalMemoryTool = getTool('add_personal_memory');
    const readonlyShellTool = getTool('readonly_shell');
    const applyPatchTool = getTool('apply_patch');
    const nonexistentTool = getTool('nonexistent');

    assertTrue(!!listDirTool, 'list_dir tool should exist');
    assertTrue(!!readFileTool, 'read_file tool should exist');
    assertTrue(!!readPictureTool, 'read_picture tool should exist');
    assertTrue(!!writePictureTool, 'write_picture tool should exist');
    assertTrue(!!addPersonalMemoryTool, 'add_personal_memory tool should exist');
    assertTrue(!!readonlyShellTool, 'readonly_shell tool should exist');
    assertTrue(!!applyPatchTool, 'apply_patch tool should exist');
    assertTrue(!!getTool('do_mind'), 'do_mind tool should exist');
    assertTrue(!!getTool('mind_more'), 'mind_more tool should exist');
    assertTrue(!!getTool('never_mind'), 'never_mind tool should exist');
    assertEqual(nonexistentTool, undefined, 'nonexistent tool should be undefined');

    console.log('Tool lookup verification passed');
  });

  await runTest('Control toolset exposes Taskdoc mutation tools', () => {
    const controlToolset = getToolset('control');
    assertTrue(Array.isArray(controlToolset), 'control toolset should be an array');
    if (!controlToolset) throw new Error('unreachable');
    assertTrue(
      controlToolset.some((tool) => tool.name === 'do_mind'),
      'control should expose do_mind',
    );
    assertTrue(
      controlToolset.some((tool) => tool.name === 'mind_more'),
      'control should expose mind_more',
    );
    assertTrue(
      controlToolset.some((tool) => tool.name === 'never_mind'),
      'control should expose never_mind',
    );
  });

  await runTest('Picture tools are exposed in workspace toolsets', () => {
    const wsReadToolset = getToolset('ws_read');
    const wsModToolset = getToolset('ws_mod');
    if (!wsReadToolset || !wsModToolset) {
      throw new Error('Expected ws_read and ws_mod toolsets to be registered');
    }
    assertTrue(
      wsReadToolset.some((tool) => tool.name === 'read_picture'),
      'ws_read should expose read_picture',
    );
    assertTrue(
      wsModToolset.some((tool) => tool.name === 'read_picture'),
      'ws_mod should expose read_picture',
    );
    assertTrue(
      wsModToolset.some((tool) => tool.name === 'write_picture'),
      'ws_mod should expose write_picture',
    );
  });

  await runTest('codex_inspect_and_patch_tools platform behavior', () => {
    const codexTools = getToolset('codex_inspect_and_patch_tools');
    if (process.platform === 'win32') {
      assertEqual(
        codexTools,
        undefined,
        'codex_inspect_and_patch_tools should not be registered on Windows',
      );
      return;
    }
    assertTrue(Array.isArray(codexTools), 'codex_inspect_and_patch_tools should be an array');
    if (!codexTools) throw new Error('unreachable');
    const names = codexTools.map((t) => t.name);
    assertEqual(
      [...names].sort(),
      ['apply_patch', 'readonly_shell'],
      'codex_inspect_and_patch_tools should expose only inspect-and-patch tools',
    );
  });

  // Test 4: Member with toolsets
  await runTest('Member with toolsets', () => {
    const testMember = new Team.Member({
      id: 'test',
      name: 'Test Member',
      provider: 'openai',
      model: 'gpt-4',
      toolsets: ['ws_read', 'personal_memory'],
      tools: ['apply_file_modification', 'list_dir'], // list_dir should be duplicate from ws_read toolset
    });

    const memberTools = testMember.listTools();
    assertTrue(memberTools.length > 0, 'Member should have tools');

    const toolNames = memberTools.map((t) => t.name).sort();
    console.log(`Member tools (${memberTools.length}): ${toolNames.join(', ')}`);

    // Verify all tools are unique
    const uniqueNames = new Set(toolNames);
    assertEqual(uniqueNames.size, toolNames.length, 'All tool names should be unique');
  });

  // Test 5: Duplicate handling
  await runTest('Duplicate handling', () => {
    const duplicateTestMember = new Team.Member({
      id: 'duplicate-test',
      name: 'Duplicate Test Member',
      provider: 'openai',
      model: 'gpt-4',
      toolsets: ['ws_read', 'ws_mod'], // both contain list_dir and read_file
      tools: ['list_dir', 'read_file'], // explicit duplicates
    });

    const tools = duplicateTestMember.listTools();
    const toolNames = tools.map((t) => t.name);

    // Count occurrences of each tool name
    const toolCounts = toolNames.reduce(
      (acc, name) => {
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    // Verify no duplicates
    for (const [toolName, count] of Object.entries(toolCounts)) {
      assertTrue(
        count === 1,
        `Tool ${toolName} should appear only once, but appears ${count} times`,
      );
    }

    console.log(`Duplicate test member tools (${tools.length}): ${toolNames.join(', ')}`);
  });

  // Test 6: YAML loading (if file exists)
  await runTest('YAML loading', async () => {
    try {
      const team = await Team.load();
      const gd = team.getMember('gd');

      if (gd) {
        const gdTools = gd.listTools();
        assertTrue(gdTools.length > 0, 'GD member should have tools');

        const toolNames = gdTools.map((t) => t.name).sort();
        console.log(`GD member tools (${gdTools.length}): ${toolNames.join(', ')}`);

        // Verify all tools are unique
        const uniqueNames = new Set(toolNames);
        assertEqual(uniqueNames.size, toolNames.length, 'GD member tools should be unique');
      } else {
        console.log('GD member not found in team configuration');
      }
    } catch (error: unknown) {
      console.log(
        `YAML loading failed (expected if .minds/team.yaml not in current directory): ${(error as Error).message}`,
      );
    }
  });

  // Test 7: Toolset registry consistency
  await runTest('Toolset registry consistency', () => {
    const toolsets = listToolsets();

    for (const [toolsetName, tools] of Object.entries(toolsets) as ReadonlyArray<
      readonly [string, readonly FuncTool[]]
    >) {
      assertTrue(Array.isArray(tools), `Toolset '${toolsetName}' should be an array`);
      assertTrue(tools.length > 0, `Toolset '${toolsetName}' should not be empty`);

      for (const tool of tools) {
        assertTrue(
          typeof tool === 'object' && 'name' in tool,
          `Each tool in '${toolsetName}' should be a Tool object`,
        );

        // Verify tool exists in registry
        const registeredTool = getTool(tool.name);
        assertTrue(
          !!registeredTool,
          `Tool '${tool.name}' from toolset '${toolsetName}' should exist in registry`,
        );
        assertEqual(
          registeredTool,
          tool,
          `Tool '${tool.name}' should be the same object in registry and toolset`,
        );
      }
    }

    console.log('Toolset registry consistency verified');
  });

  console.log('\n🎉 All tests passed!');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`❌ FAIL: ${message}`);
  process.exit(1);
});
