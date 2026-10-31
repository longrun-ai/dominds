import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MainDialog } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { Team } from '../../main/team';
import type { ToolCallOutput } from '../../main/tool';
import { readPictureTool, writePictureTool } from '../../main/tools/picture';
import { withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { toolOutputData } from '../helpers/tool-output';

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const png = Buffer.from(pngBase64, 'base64');
async function assertPicture(
  dialog: MainDialog,
  result: ToolCallOutput,
  action: string,
  requestedPath: string,
) {
  assert.equal(result.outcome, 'success');
  assert.ok(result.contentItems);
  assert.equal(result.contentItems.length, 1);
  const item = result.contentItems[0];
  assert.ok(item && item.type === 'input_image');
  assert.equal(item.mimeType, 'image/png');
  assert.equal(item.byteLength, png.length);
  assert.equal(item.artifact.rootId, dialog.id.rootId);
  assert.equal(item.artifact.selfId, dialog.id.selfId);
  assert.equal(item.artifact.status, dialog.status);
  const data = toolOutputData(result.content);
  for (const [field, value] of Object.entries({
    status: 'ok',
    action,
    path: requestedPath,
    mime_type: 'image/png',
    byte_length: png.length,
    artifact_rel_path: item.artifact.relPath,
    llm_context: 'image_attached',
  }))
    assert.equal(data[field], value);
  const artifact = path.join(
    DialogPersistence.getDialogEventsPath(dialog.id, dialog.status),
    ...item.artifact.relPath.split('/'),
  );
  const relativeArtifact = path.relative(
    DialogPersistence.getDialogEventsPath(dialog.id, dialog.status),
    artifact,
  );
  assert.ok(
    relativeArtifact !== '' &&
      relativeArtifact !== '..' &&
      !relativeArtifact.startsWith('..' + path.sep) &&
      !path.isAbsolute(relativeArtifact),
  );
  assert.deepEqual(await fs.readFile(artifact), png);
}
async function artifacts(dialog: MainDialog) {
  const base = path.join(
    DialogPersistence.getDialogEventsPath(dialog.id, dialog.status),
    'artifacts',
  );
  const snapshot: Record<string, string> = {};
  for (const name of (await fs.readdir(base, { recursive: true })).sort()) {
    const file = path.join(base, name);
    if ((await fs.stat(file)).isFile())
      snapshot[name] = (await fs.readFile(file)).toString('base64');
  }
  return snapshot;
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-picture-refusals-');
  for (const language of ['en', 'zh'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const caller = new Team.Member({
        id: 'tester',
        name: 'Tester',
        read_dirs: ['**'],
        write_dirs: ['**'],
      });
      const file = 'images-' + language + '/out.png';
      const written = await writePictureTool.call(dialog, caller, {
        path: file,
        data_base64: pngBase64,
      });
      await assertPicture(dialog, written, 'write_picture', file);
      assert.deepEqual(await fs.readFile(file), png);
      for (const [id, args] of [
        ['duplicate', { path: file, data_base64: pngBase64 }],
        [
          'signature',
          {
            path: 'images-' + language + '/spoofed.png',
            data_base64: Buffer.from('not an image').toString('base64'),
          },
        ],
      ] as const) {
        const before = await artifacts(dialog);
        const result = await writePictureTool.call(dialog, caller, args);
        assert.equal(result.outcome, 'failure');
        assert.equal(result.contentItems?.length ?? 0, 0);
        assert.deepEqual(await fs.readFile(file), png);
        assert.deepEqual(await artifacts(dialog), before);
        await assert.rejects(fs.stat('images-' + language + '/spoofed.png'), { code: 'ENOENT' });
        evidence.record({
          id: 'picture-' + id + '-' + language,
          scenario:
            id === 'duplicate'
              ? 'The default no-overwrite write refuses an existing PNG.'
              : 'A .png write receives supplied non-image bytes and is refused.',
          businessValue:
            'A refused image write preserves the existing file and emits no misleading image attachment or new artifact.',
          context: {
            language,
            submittedArguments: JSON.stringify(args),
            outcome: result.outcome,
            observedEffects:
              'Original PNG bytes and full artifact file/data snapshot unchanged; spoofed file absent; no content item.',
            scope:
              'Actual local file/signature validation and native artifact store; no pixel decoding, browser or provider request.',
          },
          reviewQuestions: [
            'Does the actual refusal explain the given duplicate/signature problem and avoid claiming the image was written or attached?',
          ],
          actualText: result.content,
        });
      }
      const read = await readPictureTool.call(dialog, caller, { path: file });
      await assertPicture(dialog, read, 'read_picture', file);
      const externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-picture-peer-'));
      console.log('Owned external picture fixture: ' + externalDirectory);
      const externalImage = path.join(externalDirectory, 'outside.png');
      await fs.writeFile(externalImage, png);
      const outsidePath = path.relative(process.cwd(), externalImage);
      assert.ok(outsidePath.startsWith('..' + path.sep));
      assert.deepEqual(await fs.readFile(externalImage), png);
      const before = await artifacts(dialog);
      const outside = await readPictureTool.call(dialog, caller, { path: outsidePath });
      assert.equal(outside.outcome, 'failure');
      assert.equal(outside.contentItems?.length ?? 0, 0);
      assert.deepEqual(await artifacts(dialog), before);
      assert.deepEqual(await fs.readFile(file), png);
      evidence.record({
        id: 'picture-outside-' + language,
        scenario: 'An image read requests an existing owned PNG beyond rtws and is refused.',
        businessValue:
          'The rtws boundary is preserved without creating an image attachment from outside scope.',
        context: {
          language,
          requestedPath: outsidePath,
          observedEffects: 'Existing file and artifact bytes unchanged; no content item.',
          scope:
            'An actual valid-signature PNG outside rtws is independently readable as owned fixture data, so ENOENT cannot explain refusal. Native tool/artifact boundary only; no decoder/provider/browser.',
        },
        reviewQuestions: [
          'Does the actual refusal accurately explain the path/access boundary without implying an outside image was read?',
        ],
        actualText: outside.content,
      });
      assert.deepEqual(await fs.readFile(externalImage), png);
      // Reached only after all assertions; failed external fixtures remain for investigation.
      await fs.rm(externalDirectory, { recursive: true });
    });
  }
  await evidence.write();
  console.log('Native picture file/artifact byte fidelity and refusal preservation: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
