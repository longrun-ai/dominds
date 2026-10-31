import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Team } from '../main/team';
import { recallTaskdocTool } from '../main/tools/ctrl';
import { updateTaskPackageSection } from '../main/utils/task-package';
import { withManualReminderDialog } from './helpers/manual-reminders';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-taskdoc-recall-budget-');
  let recorded = false;
  try {
    for (const language of ['en', 'zh'] as const) {
      await withManualReminderDialog(language, async (dialog) => {
        const caller = (await Team.load()).getMember('tester');
        assert.ok(caller);
        const head = 'unicode-head-data:7b18\n';
        const tail = '\nunicode-tail-data:36c9\n';
        const body = head + 'é'.repeat(60_000) + tail;
        const limit = 100 * 1024;
        await updateTaskPackageSection({
          taskPackageDirFullPath: path.resolve(dialog.taskDocPath),
          section: 'progress',
          content: body,
          updatedBy: caller.id,
        });
        const result = await recallTaskdocTool.call(dialog, caller, { selector: 'progress' });
        const actualBytes = Buffer.byteLength(result.content, 'utf8');
        const dataStart = result.content.indexOf(head);
        let dataEnd = dataStart >= 0 ? dataStart + head.length : 0;
        while (dataStart >= 0 && result.content.startsWith('é', dataEnd)) dataEnd++;
        const actualDataPrefix = dataStart >= 0 ? result.content.slice(dataStart, dataEnd) : '';
        const expectedPrefix =
          head +
          'é'.repeat(
            Math.floor((limit - Buffer.byteLength(head, 'utf8')) / Buffer.byteLength('é', 'utf8')),
          );
        const returnedDataBytes = Buffer.byteLength(actualDataPrefix, 'utf8');

        const file = path.join(dialog.taskDocPath, 'progress.md');
        const unchanged = (await fs.readFile(file, 'utf8')) === body;
        evidence.record({
          id: 'unicode-recall-budget-' + language,
          scenario:
            'A native Taskdoc recall reads a supplied multibyte section larger than its stated 100KiB body limit.',
          businessValue:
            'An agent receives a useful valid UTF-8 prefix and an honest incomplete-content notice within the published byte budget.',
          context: {
            language,
            selector: 'progress',
            bodyByteLimit: limit,
            inputHead: head,
            inputRepeatUnit: 'é',
            inputRepeatCount: 60_000,
            inputTail: tail,
            inputBodyBytes: Buffer.byteLength(body, 'utf8'),
            returnedGivenDataPrefixBytes: returnedDataBytes,
            expectedPrefixBytes: Buffer.byteLength(expectedPrefix, 'utf8'),
            exactGivenPrefixReturned: actualDataPrefix === expectedPrefix,
            actualReceiptBytes: actualBytes,
            fullGivenBodyReturned: result.content.includes(body),
            tailBeyondBudgetReturned: result.content.includes(tail),
            fileUnchanged: unchanged,
            scope:
              'Actual native tool/file and UTF-8 bytes. A unique given head followed by the maximal given é run identifies this controlled opaque payload without parsing natural-language labels or renderer separators. The total receipt allows up to4KiB for its separate header/notice. No LLM request, token-budget measurement, peak-memory benchmark or full-section read claim.',
          },
          reviewQuestions: [
            'Does the complete actual receipt accurately describe the returned prefix/truncation and byte units, without claiming truncation when the entire supplied body is still present?',
          ],
          actualText: result.content,
        });
        recorded = true;
        assert.equal(result.outcome, 'success');
        assert.equal(unchanged, true);
        assert.ok(dataStart >= 0);
        assert.equal(
          result.content.indexOf(head, dataStart + head.length),
          -1,
          'The controlled payload head must occur exactly once',
        );
        assert.ok(
          returnedDataBytes <= limit,
          'The actual opaque body prefix must obey its own byte limit',
        );
        assert.equal(
          actualDataPrefix,
          expectedPrefix,
          'Returned fixture data must be the exact independent UTF-8 prefix',
        );
        assert.ok(
          !result.content.includes(tail),
          'Given data beyond the body byte limit must be omitted',
        );
        assert.ok(actualBytes <= limit + 4096, 'Body byte budget plus bounded receipt overhead');
        assert.ok(
          !result.content.includes('\uFFFD'),
          'A valid UTF-8 prefix must not end in a replacement character',
        );
      });
    }
  } finally {
    // A failed budget assertion must retain the actual diagnostic for separate review.
    if (recorded) await evidence.write();
  }
  console.log('Native Unicode Taskdoc recall byte budget and file preservation: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
