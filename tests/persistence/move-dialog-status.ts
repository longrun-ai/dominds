import type { MainDialogMetadataFile } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-persistence-status-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const id = new DialogID('aa/bb/move001');
    const source: MainDialogMetadataFile = {
      id: id.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/move.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-11T00:00:00Z')),
    };
    const destination: MainDialogMetadataFile = {
      ...source,
      agentId: 'other-agent',
      taskDocPath: 'plans/preserved.tsk',
    };
    await DialogPersistence.saveMainDialogMetadata(id, source, 'running');
    await DialogPersistence.saveMainDialogMetadata(id, destination, 'completed');
    const from = DialogPersistence.getMainDialogPath(id, 'running');
    const to = DialogPersistence.getMainDialogPath(id, 'completed');
    await fs.writeFile(path.join(from, 'source-data.bin'), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(path.join(to, 'destination-data.txt'), 'destination-data\n');
    const beforeSource = await fs.readFile(path.join(from, 'dialog.yaml'));
    const beforeDestination = await fs.readFile(path.join(to, 'dialog.yaml'));
    let actualError = '';
    await assert.rejects(
      DialogPersistence.moveDialogStatus(id, 'running', 'completed'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        actualError = error.message;
        return true;
      },
    );
    assert.deepEqual(await fs.readFile(path.join(from, 'dialog.yaml')), beforeSource);
    assert.deepEqual(await fs.readFile(path.join(to, 'dialog.yaml')), beforeDestination);
    assert.deepEqual(
      await fs.readFile(path.join(from, 'source-data.bin')),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(
      await fs.readFile(path.join(to, 'destination-data.txt'), 'utf8'),
      'destination-data\n',
    );
    const archived = DialogPersistence.getMainDialogPath(id, 'archived');
    await DialogPersistence.moveDialogStatus(id, 'running', 'archived');
    await assert.rejects(fs.stat(from), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(archived, 'dialog.yaml')), beforeSource);
    assert.deepEqual(
      await fs.readFile(path.join(archived, 'source-data.bin')),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.deepEqual(await fs.readFile(path.join(to, 'dialog.yaml')), beforeDestination);
    assert.deepEqual(await DialogPersistence.loadMainDialogMetadata(id, 'archived'), source);
    evidence.record({
      id: 'existing-destination',
      scenario:
        'A status move refuses an occupied completed destination whose metadata and body differ from the running source. Both trees retain their data; a later move to an unoccupied archive preserves source bytes and removes the old path.',
      businessValue:
        'Prevent a status transition from overwriting another persisted dialog and give the operator an accurate reason for refusal.',
      context: {
        fromStatus: 'running',
        toStatus: 'completed',
        sourceRetained: true,
        destinationRetained: true,
        subsequentArchiveMoveSucceeded: true,
        scope:
          'Direct public persistence operations on real files; not a concurrent move, scheduler or WebUI transition.',
      },
      reviewQuestions: [
        'Does the actual error identify the occupied destination and refused transition, without implying deletion, successful completion or a safe automatic overwrite?',
      ],
      actualText: actualError,
    });
  });
  await evidence.write();
  console.log(
    'status refusal preserves distinct trees; successful move preserves binary and metadata: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
