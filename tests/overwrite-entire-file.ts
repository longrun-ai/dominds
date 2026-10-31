import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { overwriteEntireFileTool, padWriteTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-overwrite-guards-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const caller = new Team.Member({ id: 'editor', name: 'Editor' });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('editor');
      const file = `overwrite-${language}.yaml`;
      const original = 'members:\n  editor:\n    name: 原始值\n';
      await fs.writeFile(file, original);
      const bytes = Buffer.byteLength(original, 'utf8');
      assert.ok(bytes > original.length, 'the fixture exercises UTF-8 byte counts');
      const refused: Record<string, string> = {};
      for (const [name, lines, size] of [
        ['lines', 4, bytes],
        ['bytes', 3, bytes + 1],
      ] as const) {
        const result = await overwriteEntireFileTool.call(dlg, caller, {
          path: file,
          known_old_total_lines: lines,
          known_old_total_bytes: size,
          content: 'not-applied-data',
        });
        assert.equal(result.outcome, 'failure');
        const data = toolOutputData(result.content);
        assert.equal(data.error, 'STATS_MISMATCH');
        assert.equal(data.actual_old_total_lines, 3);
        assert.equal(data.actual_old_total_bytes, bytes);
        assert.equal(await fs.readFile(file, 'utf8'), original);
        refused[name] = result.content;
      }
      const next = 'members:\n  other:\n    name: next-data\n';
      const overwritten = await overwriteEntireFileTool.call(dlg, caller, {
        path: file,
        known_old_total_lines: 3,
        known_old_total_bytes: bytes,
        content_format: 'yaml',
        content: next,
      });
      assert.equal(overwritten.outcome, 'success');
      assert.equal(toolOutputData(overwritten.content).content_format, 'yaml');
      assert.equal(await fs.readFile(file, 'utf8'), next);
      const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n';
      const suspicious = await overwriteEntireFileTool.call(dlg, caller, {
        path: file,
        known_old_total_lines: 3,
        known_old_total_bytes: Buffer.byteLength(next),
        content_format: 'yaml',
        content: patch,
      });
      assert.equal(suspicious.outcome, 'failure');
      assert.equal(toolOutputData(suspicious.content).error, 'SUSPICIOUS_DIFF');
      assert.equal(await fs.readFile(file, 'utf8'), next);
      const explicit = await overwriteEntireFileTool.call(dlg, caller, {
        path: file,
        known_old_total_lines: 3,
        known_old_total_bytes: Buffer.byteLength(next),
        content_format: 'diff',
        content: patch,
      });
      assert.equal(explicit.outcome, 'success');
      assert.equal(
        await fs.readFile(file, 'utf8'),
        patch,
        'explicit literal diff data is stored, not applied as a patch',
      );
      const token = `overwrite-pad-data-${language}`;
      const pad = await padWriteTool.call(dlg, caller, { pad_id: 'overwrite_src', content: token });
      assert.equal(pad.outcome, 'success');
      assert.equal(pad.content.includes(token), false);
      const applied = await overwriteEntireFileTool.call(dlg, caller, {
        path: file,
        known_old_total_lines: 3,
        known_old_total_bytes: Buffer.byteLength(patch),
        content_format: 'text',
        pad_id: 'overwrite_src',
      });
      assert.equal(applied.outcome, 'success');
      assert.equal(toolOutputData(applied.content).source, 'pad');
      assert.equal(toolOutputData(applied.content).redacted, true);
      assert.equal(applied.content.includes(token), false);
      assert.equal(await fs.readFile(file, 'utf8'), `${token}\n`);
      evidence.record({
        id: language,
        scenario:
          'Overwrite refuses independently stale line and UTF-8 byte counts, succeeds with current counts, rejects undeclared diff-like data and accepts explicitly declared literal diff data.',
        businessValue:
          'Prevent accidental replacement from stale observations or mistaken patch data, while preserving explicit user intent and complete pad input.',
        context: {
          language,
          guardRefusalsPreservedFile: true,
          declaredYamlFormatOnRefusedDiff: true,
          explicitDiffStoredLiterally: true,
          finalPadBodyExact: true,
          scope:
            'Direct public tools and real file/dialog data; line/byte statistics are not a proof that file content is unchanged.',
        },
        reviewQuestions: [
          'Does the actual recovery guidance accurately describe the guard failure and a safe next step, without treating fresh statistics as authorization or proof of unchanged content?',
          'Does the diff refusal explain the actual supplied format and distinguish intentionally storing patch text from applying changes?',
          'Are success notices consistent with the observed writes?',
        ],
        actualText: JSON.stringify(
          {
            stale: refused,
            suspicious: suspicious.content,
            explicitDiff: explicit.content,
            pad: applied.content,
          },
          null,
          2,
        ),
      });
    }
  });
  await evidence.write();
  console.log(
    'overwrite preconditions, UTF-8 counts, explicit format and complete pad writes: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
