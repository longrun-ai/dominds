#!/usr/bin/env tsx

import 'dominds/tools/builtins';

import { Team } from 'dominds/team';
import { getTool, getToolset, listTools, listToolsets } from 'dominds/tools/registry';

// Helper function to run a test case
function runTest(name: string, testFn: () => void): void {
  console.log(`\n=== Testing: ${name} ===`);

  try {
    testFn();
    console.log(`✅ PASS`);
  } catch (error: unknown) {
    console.log(`❌ FAIL: ${(error as Error).message}`);
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

// Test 1: Registry functions availability
runTest('Registry functions availability', () => {
  const toolsets = listToolsets();
  const tools = listTools();

  assertTrue(Object.keys(toolsets).length > 0, 'Should have registered toolsets');
  assertTrue(tools.length > 0, 'Should have registered tools');

  console.log(`Available toolsets: ${Object.keys(toolsets).join(', ')}`);
  console.log(`Available tools count: ${tools.length}`);
});

// Test 2: Toolset lookup returns Tool objects
runTest('Toolset lookup returns Tool objects', () => {
  const wsReadToolset = getToolset('ws_read');
  const memoryToolset = getToolset('memory');
  const sharedMemoryToolset = getToolset('team_memory');
  const nonexistentToolset = getToolset('nonexistent');

  assertTrue(Array.isArray(wsReadToolset), 'ws_read toolset should be an array');
  assertTrue(Array.isArray(memoryToolset), 'memory toolset should be an array');
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
runTest('Individual tool lookup', () => {
  const listDirTool = getTool('list_dir');
  const readFileTool = getTool('read_file');
  const addMemoryTool = getTool('add_memory');
  const nonexistentTool = getTool('nonexistent');

  assertTrue(!!listDirTool, 'list_dir tool should exist');
  assertTrue(!!readFileTool, 'read_file tool should exist');
  assertTrue(!!addMemoryTool, 'add_memory tool should exist');
  assertEqual(nonexistentTool, undefined, 'nonexistent tool should be undefined');

  console.log('Tool lookup verification passed');
});

// Test 4: Member with toolsets
runTest('Member with toolsets', () => {
  const testMember = new Team.Member({
    id: 'test',
    name: 'Test Member',
    provider: 'openai',
    model: 'gpt-4',
    toolsets: ['ws_read', 'memory'],
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
runTest('Duplicate handling', () => {
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
    assertTrue(count === 1, `Tool ${toolName} should appear only once, but appears ${count} times`);
  }

  console.log(`Duplicate test member tools (${tools.length}): ${toolNames.join(', ')}`);
});

// Test 6: YAML loading (if file exists)
runTest('YAML loading', async () => {
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
runTest('Toolset registry consistency', () => {
  const toolsets = listToolsets();

  for (const [toolsetName, tools] of Object.entries(toolsets)) {
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
