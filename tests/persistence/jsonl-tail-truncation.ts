import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { DialogID } from 'dominds/dialog';
import { DialogPersistence } from 'dominds/persistence';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-jsonl-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  try {
    const dialogId = new DialogID('jsonl-test');
    const round = 1;

    // Stress append concurrency: without per-round serialization, JSONL lines can interleave.
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        await DialogPersistence.appendEvent(
          dialogId,
          round,
          {
            ts: `2026/01/30-00:00:${String(i % 60).padStart(2, '0')}`,
            type: 'agent_words_record',
            genseq: 1,
            content: `hello-${i}`,
          },
          'running',
        );
      }),
    );

    const dialogPath = DialogPersistence.getDialogEventsPath(dialogId, 'running');
    const roundFilename = DialogPersistence.getRoundFilename(round);
    const roundFilePath = path.join(dialogPath, roundFilename);

    // Simulate process crash mid-append (truncated JSONL tail).
    await fs.appendFile(
      roundFilePath,
      '{"ts":"2026/01/30-00:01:00","type":"agent_words_record","genseq":1,"content":"unterminated',
      'utf-8',
    );

    const events = await DialogPersistence.readRoundEvents(dialogId, round, 'running');
    assert(events.length === 50, `Expected 50 events, got ${events.length}`);

    console.log('✓ JSONL tail truncation tolerance test passed');
  } finally {
    process.chdir(prevCwd);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
