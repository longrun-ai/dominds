import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/shared/runtime-language';
import { Team } from '../main/team';
import { applyFileModificationTool, prepareBlockReplaceTool } from '../main/tools/txt';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function readText(p: string): Promise<string> {
  return await fs.readFile(p, 'utf-8');
}

function extractHunkId(text: string): string {
  const m = text.match(/^\s*hunk_id:\s*'?([a-z0-9_-]{2,32})'?\s*$/im);
  assert.ok(m && m[1], `expected hunk_id in output; got:\n${text}`);
  return m[1];
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-block-replace-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    // Plan succeeds on unique anchors and returns a diff + hunk id; apply succeeds.
    await writeText(
      path.join(tmpRoot, 'doc.md'),
      ['# Title', '<!-- BEGIN AUTO -->', 'old', '<!-- END AUTO -->', ''].join('\n'),
    );
    const plan1 = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'doc.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: 'new\n',
    });
    const hunk1 = extractHunkId(plan1);
    const plan1b = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'doc.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      existing_hunk_id: hunk1,
      content: 'newer\n',
    });
    const hunk1b = extractHunkId(plan1b);
    assert.equal(hunk1b, hunk1);
    assert.ok(plan1b.includes('reused_hunk_id: true'));

    const apply1 = await applyFileModificationTool.call(dlg, alice, { hunk_id: hunk1 });
    assert.ok(apply1.includes('status: ok'));
    const after1 = await readText(path.join(tmpRoot, 'doc.md'));
    assert.equal(
      after1,
      ['# Title', '<!-- BEGIN AUTO -->', 'newer', '<!-- END AUTO -->', ''].join('\n'),
    );

    // Apply rejects if the file changes between plan and apply.
    await writeText(
      path.join(tmpRoot, 'doc2.md'),
      ['# Title', '<!-- BEGIN AUTO -->', 'old', '<!-- END AUTO -->', ''].join('\n'),
    );
    const plan2 = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'doc2.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: 'new\n',
    });
    const hunk2 = extractHunkId(plan2);
    await writeText(
      path.join(tmpRoot, 'doc2.md'),
      ['# Title', '<!-- BEGIN AUTO -->', 'old (changed)', '<!-- END AUTO -->', ''].join('\n'),
    );
    const apply2 = await applyFileModificationTool.call(dlg, alice, { hunk_id: hunk2 });
    assert.ok(apply2.includes('APPLY_REJECTED_CONTENT_CHANGED'));

    // Plan fails on ambiguous anchors when occurrence is not specified.
    await writeText(
      path.join(tmpRoot, 'amb.md'),
      [
        '<!-- BEGIN AUTO -->',
        'a',
        '<!-- END AUTO -->',
        '',
        '<!-- BEGIN AUTO -->',
        'b',
        '<!-- END AUTO -->',
        '',
      ].join('\n'),
    );
    const planAmb = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'amb.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: 'x\n',
    });
    assert.ok(planAmb.includes('error: ANCHOR_AMBIGUOUS'));

    // Plan fails on missing anchors.
    await writeText(path.join(tmpRoot, 'missing.md'), ['no anchors', ''].join('\n'));
    const planMissing = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'missing.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: 'x\n',
    });
    assert.ok(planMissing.includes('error: ANCHOR_NOT_FOUND'));

    // Occurrence out of range.
    const planOor = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'amb.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: 3,
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: 'x\n',
    });
    assert.ok(planOor.includes('error: OCCURRENCE_OUT_OF_RANGE'));

    // Empty body fails with CONTENT_REQUIRED.
    const planEmpty = await prepareBlockReplaceTool.call(dlg, alice, {
      path: 'doc.md',
      start_anchor: '<!-- BEGIN AUTO -->',
      end_anchor: '<!-- END AUTO -->',
      occurrence: '',
      include_anchors: true,
      match: '',
      require_unique: true,
      strict: true,
      content: '',
    });
    assert.ok(planEmpty.includes('error: CONTENT_REQUIRED'));

    console.log('✅ block-replace-plan-apply tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
