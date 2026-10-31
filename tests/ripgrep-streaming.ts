import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { ripgrepSnippetsTool } from '../main/tools/ripgrep';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withShellDialog } from './helpers/shell-fixture';
import { toolOutputData } from './helpers/tool-output';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-ripgrep-streaming-');
  await withShellDialog('en', async (dialog, caller) => {
    const groups = Array.from({ length: 500 }, (_, index) => [
      'before-data-' + index,
      'needle hit data-' + index,
      'after-data-' + index,
    ]);
    await fs.writeFile('sample.txt', groups.flat().join('\n') + '\n');
    const result = await ripgrepSnippetsTool.call(dialog, caller, {
      pattern: 'needle',
      path: 'sample.txt',
      max_results: 5,
      context_before: 1,
      context_after: 1,
    });
    assert.equal(result.outcome, 'success');
    const data = toolOutputData(result.content);
    assert.equal(data.status, 'ok');
    assert.equal(data.mode, 'snippets');
    assert.deepEqual(data.totals, { files_matched: 1, matches: 500, shown_results: 5 });
    assert.equal(data.truncated, true);
    assert.deepEqual(
      data.results,
      groups.slice(0, 5).map(([before, match, after], index) => ({
        path: 'sample.txt',
        line: index * 3 + 2,
        col: 1,
        match,
        before: [before],
        after: [after],
        text_truncated: false,
        truncation: {
          applied: false,
          reasons: [],
          match_original_chars: match!.length,
          before_original_chars: [before!.length],
          after_original_chars: [after!.length],
        },
      })),
    );
    evidence.record({
      id: 'real-rg-bounded-snippets',
      scenario:
        'A real ripgrep process searches a real 1500-line fixture with 500 matches and returns five snippets.',
      businessValue:
        'An agent sees real line/column/context data and knows that the result list is incomplete.',
      context: {
        pattern: 'needle',
        maxResults: 5,
        actualMatches: 500,
        actualFiles: 1,
        scope:
          'Real local rg, filesystem context reads and public YAML; no peak-memory/Buffer allocation benchmark.',
      },
      reviewQuestions: [
        'Does the actual summary/truncation guidance accurately communicate the five shown of 500 and useful next steps?',
      ],
      actualText: result.content,
    });
    const complete = await ripgrepSnippetsTool.call(dialog, caller, {
      pattern: 'needle hit data-499',
      path: 'sample.txt',
      max_results: 5,
      context_before: 1,
      context_after: 1,
    });
    assert.equal(complete.outcome, 'success');
    const completeData = toolOutputData(complete.content);
    assert.deepEqual(completeData.totals, { files_matched: 1, matches: 1, shown_results: 1 });
    assert.equal(completeData.truncated, false);
    assert.deepEqual(completeData.results, [
      {
        path: 'sample.txt',
        line: 1499,
        col: 1,
        match: groups[499]![1],
        before: [groups[499]![0]],
        after: [groups[499]![2]],
        text_truncated: false,
        truncation: {
          applied: false,
          reasons: [],
          match_original_chars: groups[499]![1]!.length,
          before_original_chars: [groups[499]![0]!.length],
          after_original_chars: [groups[499]![2]!.length],
        },
      },
    ]);
  });
  await evidence.write();
  console.log('Real ripgrep counts, bounded snippets and source context: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
