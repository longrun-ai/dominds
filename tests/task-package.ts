import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { RootDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import type { Team } from '../main/team';
import { recallTaskdocTool } from '../main/tools/ctrl';
import { readTaskPackageSections, updateTaskPackageSection } from '../main/utils/task-package';
import { formatTaskDocContent } from '../main/utils/taskdoc';

function requireMessageContent(message: { type: string } & Record<string, unknown>): string {
  const content = message['content'];
  if (typeof content !== 'string') {
    throw new Error(`Expected ${message.type} to carry string content`);
  }
  return content;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-taskpkg-'));

  try {
    process.chdir(tmpRoot);

    const taskDocPath = 'my-task.tsk';
    const taskDir = path.resolve(tmpRoot, taskDocPath);
    const store = {} as unknown as DialogStore;

    // 0) Legacy single-file Taskdocs are rejected.
    const legacyDlg = new RootDialog(store, 'legacy.md', undefined, 'tester');
    const legacy = await formatTaskDocContent(legacyDlg);
    const legacyContent = requireMessageContent(legacy);
    assert.ok(legacyContent.includes('Invalid Taskdoc path') && legacyContent.includes('*.tsk'));

    // 1) Formatting should describe an encapsulated Taskdoc package.
    const dlg = new RootDialog(store, taskDocPath, undefined, 'tester');
    const msg1 = await formatTaskDocContent(dlg);
    const msg1Content = requireMessageContent(msg1);
    assert.equal(msg1.type, 'environment_msg');
    assert.equal(msg1.role, 'user');
    assert.ok(
      msg1Content.includes('Encapsulated `*.tsk/`') && msg1Content.includes('`goals.md`: missing'),
    );
    assert.ok(
      msg1Content.includes(
        '`progress` is the team-shared, quasi-real-time, scannable task bulletin board for current effective state, key decisions, next steps, and still-active blockers',
      ),
    );

    setWorkLanguage('zh');
    const msg1Zh = await formatTaskDocContent(dlg);
    const msg1ZhContent = requireMessageContent(msg1Zh);
    assert.ok(
      msg1ZhContent.includes(
        '`progress` 是全队共享、准实时、可扫读的任务公告牌，用于当前有效状态、关键决策、下一步与仍成立阻塞，不是“我当前在做什么”的个人笔记',
      ),
    );
    setWorkLanguage('en');

    // Note: formatting does not auto-create files; Taskdoc package updates should be explicit.
    assert.ok(!(await pathExists(taskDir)));

    // 2) Section updates should overwrite the target file and be reflected in effective doc.
    const newGoals = ['- Ship v1', '- Zero regressions'].join('\n');
    await updateTaskPackageSection({
      taskPackageDirFullPath: taskDir,
      section: 'goals',
      content: newGoals,
      updatedBy: 'tester',
    });
    const newConstraints = ['- No web browsing', '- Keep diffs minimal'].join('\n');
    await updateTaskPackageSection({
      taskPackageDirFullPath: taskDir,
      section: 'constraints',
      content: newConstraints,
      updatedBy: 'tester',
    });
    const newProgress = ['- Updated Taskdoc selector vocabulary'].join('\n');
    await updateTaskPackageSection({
      taskPackageDirFullPath: taskDir,
      section: 'progress',
      content: newProgress,
      updatedBy: 'tester',
    });

    const sections = await readTaskPackageSections(taskDir);
    assert.equal(sections.goals.kind, 'present');
    assert.equal(sections.constraints.kind, 'present');
    assert.equal(sections.progress.kind, 'present');
    assert.equal(sections.goals.content, newGoals);
    assert.equal(sections.constraints.content, newConstraints);
    assert.equal(sections.progress.content, newProgress);

    const msg2 = await formatTaskDocContent(dlg);
    const msg2Content = requireMessageContent(msg2);
    assert.ok(msg2Content.includes('## Goals'));
    assert.ok(msg2Content.includes(newGoals));
    assert.ok(msg2Content.includes('## Constraints'));
    assert.ok(msg2Content.includes(newConstraints));
    assert.ok(!msg2Content.includes('## Bear In Mind'));
    assert.ok(msg2Content.includes('## Progress'));
    assert.ok(msg2Content.includes(newProgress));

    // 3) Optional injected bearinmind/ should be included (fixed order) and bounded.
    await fs.mkdir(path.join(taskDir, 'bearinmind'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'bearinmind', 'contracts.md'), 'C\n', 'utf-8');
    await fs.writeFile(path.join(taskDir, 'bearinmind', 'risks.md'), 'R\n', 'utf-8');
    await fs.writeFile(path.join(taskDir, 'bearinmind', 'extra.md'), 'NO\n', 'utf-8');

    const msg3 = await formatTaskDocContent(dlg);
    const msg3Content = requireMessageContent(msg3);
    assert.ok(msg3Content.includes('## Bear In Mind'));
    assert.ok(msg3Content.includes('### contracts.md'));
    assert.ok(msg3Content.includes('C\n'));
    assert.ok(msg3Content.includes('### risks.md'));
    assert.ok(msg3Content.includes('R\n'));
    assert.ok(!msg3Content.includes('NO\n'));
    assert.ok(msg3Content.indexOf('## Constraints') < msg3Content.indexOf('## Bear In Mind'));
    assert.ok(msg3Content.indexOf('## Bear In Mind') < msg3Content.indexOf('## Progress'));

    // 4) Extra categories are not auto-injected as content, but should appear as an index entry,
    // and should be readable via `recall_taskdoc`.
    await fs.mkdir(path.join(taskDir, 'ux'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'ux', 'checklist.md'), 'UX\n', 'utf-8');

    const msg4 = await formatTaskDocContent(dlg);
    const msg4Content = requireMessageContent(msg4);
    assert.ok(msg4Content.includes('**Extra sections index'));
    assert.ok(msg4Content.includes('`ux/checklist.md`'));

    const recall = (
      await recallTaskdocTool.call(dlg, {} as unknown as Team.Member, {
        category: 'ux',
        selector: 'checklist',
      })
    ).content;
    assert.ok(recall.includes('`ux/checklist.md`'));
    assert.ok(recall.includes('UX\n'));

    console.log('✅ task-package tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
