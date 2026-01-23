#!/usr/bin/env tsx

import type { Dialog } from 'dominds/dialog';
import { Team } from 'dominds/team';
import { verifyTellaskParsingTool } from 'dominds/tools/diag';

function assertTrue(condition: boolean, message?: string): void {
  if (!condition) {
    throw new Error(message || 'Assertion failed: expected truthy value');
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (Object.is(actual, expected)) return;
  throw new Error(
    `${message || 'Assertion failed'}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== Testing: ${name} ===`);
  try {
    await fn();
    console.log('✅ PASS');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ FAIL: ${message}`);
    process.exit(1);
  }
}

type ToolOutput = Readonly<{
  ok: boolean;
  primary?: Readonly<{
    segments: ReadonlyArray<unknown>;
    collected_calls: ReadonlyArray<unknown>;
  }>;
  analysis?: Readonly<{
    invariance?: Readonly<{ failures?: ReadonlyArray<unknown> }>;
    random_invariance?: Readonly<{ failures?: ReadonlyArray<unknown> }>;
    event_sequence?: Readonly<{ ok?: boolean }>;
  }>;
  error?: unknown;
}>;

function parseToolOutput(raw: string): ToolOutput {
  const parsed: unknown = JSON.parse(raw);
  assertTrue(typeof parsed === 'object' && parsed !== null, 'Tool output must be an object');
  return parsed as ToolOutput;
}

async function main(): Promise<void> {
  const caller = new Team.Member({
    id: 'pm',
    name: 'Product Manager',
    write_dirs: ['**/*'],
    no_write_dirs: [],
  });

  const dlg = {} as unknown as Dialog;

  await runTest('verify_tellask_parsing basic', async () => {
    const text = [
      'Hello before',
      '!?@tool1 cmd arg',
      '!?body line 1',
      '!?body line 2',
      'after',
      '',
    ].join('\n');

    const raw = await verifyTellaskParsingTool.call(dlg, caller, {
      text,
      upstream_chunk_size: 10,
      invariance_chunk_sizes: [1, 2, 3, 5, 8],
      random_invariance_seeds: [1, 2, 3],
      random_invariance_max_chunk_size: 12,
      include_events: false,
    });
    const out = parseToolOutput(raw);

    assertEqual(out.ok, true, 'Expected ok=true');
    assertTrue(out.primary !== undefined, 'Expected primary output');
    assertTrue(Array.isArray(out.primary.segments), 'Expected segments array');
    assertTrue(Array.isArray(out.primary.collected_calls), 'Expected collected_calls array');
    assertTrue(out.analysis !== undefined, 'Expected analysis output');
    assertTrue(out.analysis.event_sequence !== undefined, 'Expected event_sequence');
    assertEqual(out.analysis.event_sequence.ok, true, 'Expected event sequence ok');
    assertTrue(out.analysis.invariance !== undefined, 'Expected invariance');
    assertEqual((out.analysis.invariance.failures ?? []).length, 0, 'Expected invariance pass');
    assertTrue(out.analysis.random_invariance !== undefined, 'Expected random_invariance');
    assertEqual(
      (out.analysis.random_invariance.failures ?? []).length,
      0,
      'Expected random invariance pass',
    );
  });

  await runTest('verify_tellask_parsing supports empty chunks in plan', async () => {
    const text = '!?@tool1 args\n!?Body content\n';
    const raw = await verifyTellaskParsingTool.call(dlg, caller, {
      text,
      chunk_sizes: [10, 0, 15, 0, 5],
      include_events: false,
      invariance_chunk_sizes: [1, 2, 7],
      random_invariance_seeds: [],
    });
    const out = parseToolOutput(raw);
    assertEqual(out.ok, true, 'Expected ok=true');
    assertTrue(out.analysis !== undefined, 'Expected analysis output');
    assertTrue(out.analysis.invariance !== undefined, 'Expected invariance');
    assertEqual((out.analysis.invariance.failures ?? []).length, 0, 'Expected invariance pass');
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Unexpected error:', message);
  process.exit(1);
});
