import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTaskPackageSections, updateTaskPackageSection } from '../main/utils/task-package';
import { formatTaskDocContent } from '../main/utils/taskdoc';

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

    // 0) Legacy single-file task docs are rejected.
    const legacy = await formatTaskDocContent('legacy.md');
    assert.ok(
      typeof legacy.content === 'string' &&
        legacy.content.includes('Invalid Taskdoc path') &&
        legacy.content.includes('*.tsk'),
    );

    // 1) Formatting should describe an encapsulated Taskdoc package.
    const msg1 = await formatTaskDocContent(taskDocPath);
    assert.equal(msg1.type, 'environment_msg');
    assert.equal(msg1.role, 'user');
    assert.ok(
      typeof msg1.content === 'string' &&
        msg1.content.includes('Encapsulated `*.tsk/`') &&
        msg1.content.includes('Missing `goals.md`'),
    );

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

    const msg2 = await formatTaskDocContent(taskDocPath);
    assert.ok(typeof msg2.content === 'string');
    assert.ok(msg2.content.includes('## Goals'));
    assert.ok(msg2.content.includes(newGoals));
    assert.ok(msg2.content.includes('## Constraints'));
    assert.ok(msg2.content.includes(newConstraints));
    assert.ok(msg2.content.includes('## Progress'));
    assert.ok(msg2.content.includes(newProgress));

    console.log('✅ task-package tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
