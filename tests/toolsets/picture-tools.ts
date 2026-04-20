#!/usr/bin/env tsx

import type { FuncResultContentItem } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DialogID, type Dialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { Team } from '../../main/team';
import { readPictureTool, writePictureTool } from '../../main/tools/picture';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function buildDialog(): Dialog {
  return {
    id: new DialogID('picture-tool-test'),
    status: 'running',
  } as unknown as Dialog;
}

function assertImageContentItem(item: FuncResultContentItem): void {
  assert.equal(item.type, 'input_image');
  if (item.type !== 'input_image') return;
  assert.equal(item.mimeType, 'image/png');
  assert.ok(item.byteLength > 0);
  assert.equal(item.artifact.rootId, 'picture-tool-test');
  assert.equal(item.artifact.selfId, 'picture-tool-test');
  assert.equal(item.artifact.status, 'running');
  assert.ok(item.artifact.relPath.startsWith('artifacts/workspace/'));
}

async function assertArtifactExists(dlg: Dialog, relPath: string): Promise<void> {
  const absPath = path.join(
    DialogPersistence.getDialogEventsPath(dlg.id, dlg.status),
    ...relPath.split('/'),
  );
  const stat = await fs.stat(absPath);
  assert.equal(stat.isFile(), true);
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const rtws = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-picture-tools-'));
  try {
    process.chdir(rtws);
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    const dlg = buildDialog();

    const writeResult = await writePictureTool.call(dlg, caller, {
      path: 'images/out.png',
      data_base64: ONE_PIXEL_PNG_BASE64,
    });
    assert.equal(writeResult.outcome, 'success');
    assert.match(writeResult.content, /action: write_picture/);
    assert.equal(writeResult.contentItems?.length, 1);
    const writtenItem = writeResult.contentItems?.[0];
    assert.ok(writtenItem);
    assertImageContentItem(writtenItem);
    if (writtenItem.type === 'input_image') {
      await assertArtifactExists(dlg, writtenItem.artifact.relPath);
    }

    const bytes = await fs.readFile(path.join(rtws, 'images/out.png'));
    assert.deepEqual(bytes, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

    const duplicateResult = await writePictureTool.call(dlg, caller, {
      path: 'images/out.png',
      data_base64: ONE_PIXEL_PNG_BASE64,
    });
    assert.equal(duplicateResult.outcome, 'failure');
    assert.match(duplicateResult.content, /File already exists/);

    const spoofedResult = await writePictureTool.call(dlg, caller, {
      path: 'images/spoofed.png',
      data_base64: Buffer.from('not an image').toString('base64'),
    });
    assert.equal(spoofedResult.outcome, 'failure');
    assert.match(spoofedResult.content, /supported PNG\/JPEG\/WebP\/GIF signature/);

    const readResult = await readPictureTool.call(dlg, caller, {
      path: 'images/out.png',
    });
    assert.equal(readResult.outcome, 'success');
    assert.match(readResult.content, /action: read_picture/);
    assert.equal(readResult.contentItems?.length, 1);
    const readItem = readResult.contentItems?.[0];
    assert.ok(readItem);
    assertImageContentItem(readItem);
    if (readItem.type === 'input_image') {
      await assertArtifactExists(dlg, readItem.artifact.relPath);
    }

    const deniedResult = await readPictureTool.call(dlg, caller, {
      path: '../outside.png',
    });
    assert.equal(deniedResult.outcome, 'failure');

    console.log('OK');
  } finally {
    process.chdir(previousCwd);
    await fs.rm(rtws, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
