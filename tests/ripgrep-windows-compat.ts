import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { ToolArguments } from '../main/tool';
import { fsRipgrepFilesTool, ripgrepFilesTool, ripgrepSearchTool } from '../main/tools/ripgrep';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withShellDialog } from './helpers/shell-fixture';
import { toolOutputData } from './helpers/tool-output';

function resultPaths(data: Record<string, unknown>) {
  assert.ok(Array.isArray(data.results));
  return data.results
    .map((row: unknown) => {
      assert.ok(row && typeof row === 'object' && 'path' in row && typeof row.path === 'string');
      return path.normalize(row.path);
    })
    .sort();
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-ripgrep-paths-');
  await withShellDialog('en', async (dialog, caller) => {
    await fs.mkdir('src');
    await fs.writeFile('src/alpha.ts', 'needle\n');
    await fs.writeFile('src/beta.tsx', 'needle\n');
    const filtered = await ripgrepFilesTool.call(dialog, caller, {
      pattern: 'needle',
      path: '.\\src',
      include: '*.ts',
    });
    assert.equal(filtered.outcome, 'success');
    const first = toolOutputData(filtered.content);
    assert.equal(first.status, 'ok');
    assert.deepEqual(first.totals, { files_matched: 1 });
    assert.deepEqual(resultPaths(first), [path.normalize('src/alpha.ts')]);
    const mixed = await ripgrepSearchTool.call(dialog, caller, {
      pattern: 'needle',
      path: '.\\src',
      rg_args: ['-g', '*.ts', '-g', 'src/*'],
    });
    assert.equal(mixed.outcome, 'success');
    const second = toolOutputData(mixed.content);
    assert.equal(second.status, 'ok');
    assert.deepEqual(second.totals, { files_matched: 2, matches: 2, shown_results: 2 });
    assert.deepEqual(
      resultPaths(second),
      ['src/alpha.ts', 'src/beta.tsx'].map((value) => path.normalize(value)).sort(),
    );
    const nativePath = process.platform === 'win32' ? 'literal/slash' : 'literal\\slash';
    await fs.mkdir(nativePath, { recursive: true });
    await fs.writeFile(nativePath + '/path-data.txt', 'needle\n');
    const literal = await ripgrepFilesTool.call(dialog, caller, {
      pattern: 'needle',
      path: 'literal\\slash',
    });
    assert.equal(literal.outcome, 'success');
    const literalData = toolOutputData(literal.content);
    assert.deepEqual(literalData.totals, { files_matched: 1 });
    assert.deepEqual(resultPaths(literalData), [path.normalize(nativePath + '/path-data.txt')]);
    const scenarios: Array<[string, ToolArguments, string, string]> = [
      ['no-matches', { pattern: 'absent-pattern-data:83a2', path: 'src' }, 'success', 'ok'],
      [
        'fs-native-missing-path',
        { pattern: 'needle', path: 'absent-path-data' },
        'partial_failure',
        'partial_failure',
      ],
      [
        'native-missing-path',
        { pattern: 'needle', path: 'absent-path-data' },
        'partial_failure',
        'partial_failure',
      ],
      [
        'invalid-flag',
        { pattern: 'needle', path: 'src', rg_args: ['--invalid-fixture-flag-data'] },
        'failure',
        'error',
      ],
    ];
    for (const [id, args, outcome, status] of scenarios) {
      const result = await (
        id === 'invalid-flag'
          ? ripgrepSearchTool
          : id === 'fs-native-missing-path'
            ? fsRipgrepFilesTool
            : ripgrepFilesTool
      ).call(dialog, caller, args);
      assert.equal(result.outcome, outcome, id + '\n' + result.content);
      const data = toolOutputData(result.content);
      assert.equal(data.status, status);
      if (status !== 'error') {
        assert.deepEqual(data.totals, { files_matched: 0 });
        assert.equal(data.results ?? null, null);
      }
      evidence.record({
        id,
        scenario: 'A real local rg request returns ' + id + '.',
        businessValue:
          'An agent distinguishes a complete empty result from unavailable search scope or invalid options.',
        context: {
          request: JSON.stringify(args),
          platform: process.platform,
          outcome,
          scope:
            'Real rg child process and local filesystem; no native Windows inference on other platforms.',
        },
        reviewQuestions: [
          'Does the actual diagnostic/summary accurately communicate whether search succeeded, was partial, or failed, without treating unavailable scope as proof of no matches?',
        ],
        actualText: result.content,
      });
    }
    const fsPositive = await fsRipgrepFilesTool.call(dialog, caller, {
      pattern: 'needle',
      path: 'src',
    });
    assert.equal(fsPositive.outcome, 'success');
    assert.deepEqual(
      resultPaths(toolOutputData(fsPositive.content)),
      ['src/alpha.ts', 'src/beta.tsx'].map((value) => path.normalize(value)).sort(),
    );
    if (process.platform !== 'win32') {
      await fs.symlink('absent-link-target-data', 'src/broken-link-data');
      const result = await ripgrepFilesTool.call(dialog, caller, {
        pattern: 'needle',
        path: 'src',
        follow_symlinks: true,
      });
      assert.equal(result.outcome, 'partial_failure', result.content);
      const data = toolOutputData(result.content);
      assert.equal(data.status, 'partial_failure');
      assert.deepEqual(data.totals, { files_matched: 2 });
      assert.deepEqual(
        resultPaths(data),
        ['src/alpha.ts', 'src/beta.tsx'].map((value) => path.normalize(value)).sort(),
      );
      evidence.record({
        id: 'native-partial-with-matches',
        scenario: 'Real rg follows a broken symlink alongside two matching regular files.',
        businessValue:
          'Useful matches survive while an agent learns that part of the scope was unavailable.',
        context: {
          platform: process.platform,
          knownMatches: 2,
          brokenLink: 'src/broken-link-data',
          scope: 'Real local rg and POSIX symlink; no Windows link privilege or filesystem claim.',
        },
        reviewQuestions: [
          'Does the actual complete summary accurately retain two matches while marking the search partial?',
        ],
        actualText: result.content,
      });
    } else
      console.log('UNEXECUTED: native POSIX broken-symlink partial-with-matches case on Windows.');
    const originalSpawn = childProcess.spawn;
    const stderrData = 'refs/desktop: The system cannot find the path specified. (os error 3)\n';
    let delegated = 0;
    try {
      // Control only the external rg boundary, using a real native child and real stdout/stderr/exit events.
      childProcess.spawn = new Proxy(originalSpawn, {
        apply(target, thisArg, args) {
          if (args[0] !== 'rg') return Reflect.apply(target, thisArg, args);
          delegated++;
          return originalSpawn(
            process.execPath,
            ['-e', 'process.stderr.write(' + JSON.stringify(stderrData) + ');process.exitCode=2;'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
        },
      });
      syncBuiltinESMExports();
      const result = await ripgrepFilesTool.call(dialog, caller, {
        pattern: 'needle',
        path: '.\\src',
      });
      assert.equal(delegated, 1);
      assert.equal(result.outcome, 'partial_failure');
      const data = toolOutputData(result.content);
      assert.equal(data.status, 'partial_failure');
      assert.deepEqual(data.totals, { files_matched: 0 });
      evidence.record({
        id: 'controlled-windows-os-error-3',
        scenario:
          'A controlled external peer emits supplied Windows path-error stderr and real exit code 2.',
        businessValue:
          'A path failure cannot silently become a successful exhaustive empty search.',
        context: {
          stderrData,
          exitCode: 2,
          platform: process.platform,
          scope:
            'Actual local child pipes/exit and tool handling, controlled rg peer only; no native Windows filesystem or executable.',
        },
        reviewQuestions: [
          'Does the actual full output clearly mark a partial search with a path failure rather than asserting exhaustive absence?',
        ],
        actualText: result.content,
      });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    evidence.record({
      id: 'native-ts-filter',
      scenario: 'An include filter excludes .tsx from the supplied .ts/.tsx files.',
      businessValue:
        'An agent sees the requested extension scope and any genuine filter limitations.',
      context: {
        platform: process.platform,
        request: JSON.stringify({ pattern: 'needle', path: '.\\src', include: '*.ts' }),
        scope:
          'Real rg on current platform; no assertion about internal --type/--glob implementation or Windows execution elsewhere.',
      },
      reviewQuestions: [
        'Does the full actual summary/filter guidance accurately reflect the one .ts file returned?',
      ],
      actualText: filtered.content,
    });
    console.log(
      'UNEXECUTED: native ripgrep on other operating systems; current platform ' +
        process.platform +
        '.',
    );
  });
  await evidence.write();
  console.log(
    'Native rg filters/path semantics and controlled Windows stderr handling: PASS for stated scope.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
