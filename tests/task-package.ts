import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DialogStore, MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import type { Team } from '../main/team';
import {
  changeMindTool,
  doMindTool,
  mindMoreTool,
  neverMindTool,
  recallTaskdocTool,
} from '../main/tools/ctrl';
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

function assertSingleTrailingLf(content: string, label: string): void {
  assert.ok(content.endsWith('\n'), `${label} should end with LF`);
  assert.ok(!content.endsWith('\r\n'), `${label} should not end with CRLF`);
  assert.ok(!content.endsWith('\n\n'), `${label} should not grow extra trailing blank lines`);
}

class TestDialogStore extends DialogStore {}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-taskpkg-'));

  try {
    process.chdir(tmpRoot);

    const taskDocPath = 'my-task.tsk';
    const taskDir = path.resolve(tmpRoot, taskDocPath);
    const store = new TestDialogStore();

    // 0) Legacy single-file Taskdocs are rejected.
    const legacyDlg = new MainDialog(store, 'legacy.md', undefined, 'tester');
    const legacy = await formatTaskDocContent(legacyDlg);
    const legacyContent = requireMessageContent(legacy);
    assert.ok(legacyContent.includes('Invalid Taskdoc path') && legacyContent.includes('*.tsk'));

    // Prefix-sibling paths must not pass the workspace containment check.
    const siblingTaskDocPath = path.relative(tmpRoot, `${tmpRoot}-sibling.tsk`);
    const siblingDlg = new MainDialog(store, siblingTaskDocPath, undefined, 'tester');
    const sibling = await formatTaskDocContent(siblingDlg);
    const siblingContent = requireMessageContent(sibling);
    assert.ok(siblingContent.includes('Path must be within rtws'));
    const siblingAppend = await mindMoreTool.call(
      siblingDlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        items: ['- should not write outside rtws'],
      },
    );
    assert.equal(siblingAppend.outcome, 'failure');
    assert.ok(siblingAppend.content.includes('Path must be within rtws'));

    // 1) Formatting should describe an encapsulated Taskdoc package.
    const dlg = new MainDialog(store, taskDocPath, undefined, 'tester');
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
    assert.ok(
      msg1Content.includes('Create missing resident sections with the function tool `do_mind`'),
    );
    assert.ok(msg1Content.includes('`do_mind({"selector":"goals","content":"..."})`'));

    setWorkLanguage('zh');
    const msg1Zh = await formatTaskDocContent(dlg);
    const msg1ZhContent = requireMessageContent(msg1Zh);
    assert.ok(
      msg1ZhContent.includes(
        '`progress` 是全队共享、准实时、可扫读的任务公告牌，用于当前有效状态、关键决策、下一步与仍成立阻塞，不是“我当前在做什么”的个人笔记',
      ),
    );
    assert.ok(msg1ZhContent.includes('缺失的常驻分段请用函数工具 `do_mind` 创建'));
    assert.ok(msg1ZhContent.includes('`do_mind({"selector":"goals","content":"..."})`'));
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
    assert.equal(sections.goals.content, `${newGoals}\n`);
    assert.equal(sections.constraints.content, `${newConstraints}\n`);
    assert.equal(sections.progress.content, `${newProgress}\n`);

    const msg2 = await formatTaskDocContent(dlg);
    const msg2Content = requireMessageContent(msg2);
    assert.ok(msg2Content.includes('use `mind_more` to append small notes'));
    assert.ok(msg2Content.includes('use `change_mind` for full-section rewrite/merge'));
    assert.ok(msg2Content.includes('## Goals'));
    assert.ok(msg2Content.includes(newGoals));
    assert.ok(msg2Content.includes('- Zero regressions\n\n## Constraints'));
    assert.ok(!msg2Content.includes('- Zero regressions\n\n\n## Constraints'));
    assert.ok(msg2Content.includes('## Constraints'));
    assert.ok(msg2Content.includes(newConstraints));
    assert.ok(!msg2Content.includes('## Bear In Mind'));
    assert.ok(msg2Content.includes('## Progress'));
    assert.ok(msg2Content.includes(newProgress));

    const sideDlg = await dlg.createSideDialog('sidekick', ['@sidekick'], 'Check Taskdoc copy.', {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: dlg.id.selfId,
      callId: 'call-side-taskdoc-copy',
      callSiteCourse: 1,
      callSiteGenseq: 1,
    });
    const sideMsg = await formatTaskDocContent(sideDlg);
    const sideMsgContent = requireMessageContent(sideMsg);
    assert.ok(
      sideMsgContent.includes(
        'Side Dialogs cannot call `do_mind` / `mind_more` / `change_mind` / `never_mind`',
      ),
    );
    const sideMutationFailures = [
      await doMindTool.call(sideDlg, { id: 'tester' } as unknown as Team.Member, {
        selector: 'ux',
        content: 'new section',
      }),
      await changeMindTool.call(sideDlg, { id: 'tester' } as unknown as Team.Member, {
        selector: 'progress',
        content: 'replacement',
      }),
      await mindMoreTool.call(sideDlg, { id: 'tester' } as unknown as Team.Member, {
        items: ['- appended'],
      }),
      await neverMindTool.call(sideDlg, { id: 'tester' } as unknown as Team.Member, {
        selector: 'progress',
      }),
    ];
    for (const failure of sideMutationFailures) {
      assert.equal(failure.outcome, 'failure');
      assert.ok(failure.content.includes('do_mind'));
      assert.ok(failure.content.includes('mind_more'));
      assert.ok(failure.content.includes('change_mind'));
      assert.ok(failure.content.includes('never_mind'));
    }
    setWorkLanguage('zh');
    const sideMsgZh = await formatTaskDocContent(sideDlg);
    const sideMsgZhContent = requireMessageContent(sideMsgZh);
    assert.ok(
      sideMsgZhContent.includes(
        '支线对话中不允许 `do_mind` / `mind_more` / `change_mind` / `never_mind`',
      ),
    );
    setWorkLanguage('en');

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
    assert.ok(msg3Content.includes('C\n### risks.md'));
    assert.ok(!msg3Content.includes('C\n\n### risks.md'));
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
    assert.ok(recall.includes('UX\n---'));
    assert.ok(!recall.includes('UX\n\n---'));

    const missingRecall = (
      await recallTaskdocTool.call(dlg, {} as unknown as Team.Member, {
        category: 'ux',
        selector: 'missing',
      })
    ).content;
    assert.ok(missingRecall.includes('do_mind'));
    assert.ok(missingRecall.includes('mind_more'));
    assert.ok(missingRecall.includes('change_mind'));

    const createExtraResult = await doMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'notes',
        content: 'UX notes\r\n\r\n',
      },
    );
    assert.equal(createExtraResult.outcome, 'success');
    const createdNotesContent = await fs.readFile(path.join(taskDir, 'ux', 'notes.md'), 'utf-8');
    assert.equal(createdNotesContent, 'UX notes\n');
    assertSingleTrailingLf(createdNotesContent, 'ux/notes.md');

    const duplicateCreateResult = await doMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'notes',
        content: 'should not overwrite',
      },
    );
    assert.equal(duplicateCreateResult.outcome, 'failure');
    assert.ok(duplicateCreateResult.content.includes('already exists'));
    assert.equal(await fs.readFile(path.join(taskDir, 'ux', 'notes.md'), 'utf-8'), 'UX notes\n');

    const changeMissingResult = await changeMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'missing',
        content: 'should not create',
      },
    );
    assert.equal(changeMissingResult.outcome, 'failure');
    assert.ok(changeMissingResult.content.includes('does not exist'));
    assert.ok(!(await pathExists(path.join(taskDir, 'ux', 'missing.md'))));

    const changeMindResult = await changeMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'checklist',
        content: 'UX replaced\r\n\r\n',
      },
    );
    assert.equal(changeMindResult.outcome, 'success');
    const changedChecklistContent = await fs.readFile(
      path.join(taskDir, 'ux', 'checklist.md'),
      'utf-8',
    );
    assert.equal(changedChecklistContent, 'UX replaced\n');
    assertSingleTrailingLf(changedChecklistContent, 'ux/checklist.md');

    const neverMindInvalidCategory = await neverMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 123,
        selector: 'checklist',
      },
    );
    assert.equal(neverMindInvalidCategory.outcome, 'failure');
    assert.ok(neverMindInvalidCategory.content.includes('never_mind'));
    assert.ok(await pathExists(path.join(taskDir, 'ux', 'checklist.md')));

    const neverMindResult = await neverMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'checklist',
      },
    );
    assert.equal(neverMindResult.outcome, 'success');
    assert.ok(!(await pathExists(path.join(taskDir, 'ux', 'checklist.md'))));

    const neverMindMissingResult = await neverMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        category: 'ux',
        selector: 'checklist',
      },
    );
    assert.equal(neverMindMissingResult.outcome, 'failure');
    assert.ok(neverMindMissingResult.content.includes('ux/checklist.md'));
    assert.ok(!neverMindMissingResult.content.includes('mind_more'));
    assert.ok(!neverMindMissingResult.content.includes('change_mind'));

    // 5) mind_more should append entries without requiring a full-section replacement.
    const appendResult = await mindMoreTool.call(dlg, { id: 'tester' } as unknown as Team.Member, {
      items: ['- Worker A finished backend wiring', '- Next: verify UI contract'],
    });
    assert.equal(appendResult.outcome, 'success');

    const appended = await readTaskPackageSections(taskDir);
    assert.equal(appended.progress.kind, 'present');
    assert.equal(
      appended.progress.content,
      [
        '- Updated Taskdoc selector vocabulary',
        '- Worker A finished backend wiring',
        '- Next: verify UI contract',
      ].join('\n') + '\n',
    );
    assertSingleTrailingLf(appended.progress.content, 'progress.md');

    const goalsAppend = await mindMoreTool.call(dlg, { id: 'tester' } as unknown as Team.Member, {
      selector: 'goals',
      items: ['- Keep Taskdoc updates low-friction'],
      sep: '\n\n',
    });
    assert.equal(goalsAppend.outcome, 'success');
    const appendedGoals = await readTaskPackageSections(taskDir);
    assert.equal(appendedGoals.goals.kind, 'present');
    assert.equal(
      appendedGoals.goals.content,
      ['- Ship v1', '- Zero regressions'].join('\n') +
        '\n\n' +
        '- Keep Taskdoc updates low-friction\n',
    );
    assertSingleTrailingLf(appendedGoals.goals.content, 'goals.md');

    await updateTaskPackageSection({
      taskPackageDirFullPath: taskDir,
      section: 'constraints',
      content: '- Existing constraint\r\r',
      updatedBy: 'tester',
    });
    const constraintsAppend = await mindMoreTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        selector: 'constraints',
        items: ['- Added constraint'],
        sep: '\n\n',
      },
    );
    assert.equal(constraintsAppend.outcome, 'success');
    const appendedConstraints = await readTaskPackageSections(taskDir);
    assert.equal(appendedConstraints.constraints.kind, 'present');
    assert.equal(
      appendedConstraints.constraints.content,
      '- Existing constraint\n\n- Added constraint\n',
    );
    assertSingleTrailingLf(appendedConstraints.constraints.content, 'constraints.md');

    const constraintsFileContent = await fs.readFile(path.join(taskDir, 'constraints.md'), 'utf-8');
    assertSingleTrailingLf(constraintsFileContent, 'constraints.md on disk');

    await updateTaskPackageSection({
      taskPackageDirFullPath: taskDir,
      section: 'constraints',
      content: '',
      updatedBy: 'tester',
    });
    const emptyConstraintsFileContent = await fs.readFile(
      path.join(taskDir, 'constraints.md'),
      'utf-8',
    );
    assert.equal(emptyConstraintsFileContent, '');

    const deleteTopLevelResult = await neverMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        selector: 'constraints',
      },
    );
    assert.equal(deleteTopLevelResult.outcome, 'success');
    const afterTopLevelDelete = await readTaskPackageSections(taskDir);
    assert.equal(afterTopLevelDelete.constraints.kind, 'missing');

    const recreateTopLevelResult = await doMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        selector: 'constraints',
        content: '- Recreated constraint\r\n\r\n',
      },
    );
    assert.equal(recreateTopLevelResult.outcome, 'success');
    const recreatedConstraintsFileContent = await fs.readFile(
      path.join(taskDir, 'constraints.md'),
      'utf-8',
    );
    assert.equal(recreatedConstraintsFileContent, '- Recreated constraint\n');
    assertSingleTrailingLf(recreatedConstraintsFileContent, 'recreated constraints.md');

    const duplicateTopLevelCreateResult = await doMindTool.call(
      dlg,
      { id: 'tester' } as unknown as Team.Member,
      {
        selector: 'constraints',
        content: 'should not overwrite',
      },
    );
    assert.equal(duplicateTopLevelCreateResult.outcome, 'failure');
    assert.ok(duplicateTopLevelCreateResult.content.includes('already exists'));
    assert.equal(
      await fs.readFile(path.join(taskDir, 'constraints.md'), 'utf-8'),
      '- Recreated constraint\n',
    );

    console.log('✅ task-package tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
