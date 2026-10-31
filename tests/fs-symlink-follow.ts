import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import type { FuncTool, ToolCallOutput } from '../main/tool';
import '../main/tools/builtins';
import {
  createSymlinkTool,
  listDirTool,
  mkDirTool,
  moveDirTool,
  moveFileTool,
  readSymlinkTool,
  rmDirTool,
  rmFileTool,
  rmSymlinkTool,
} from '../main/tools/fs';
import { getTool } from '../main/tools/registry';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-filesystem-links-');
function func(name: string): FuncTool {
  const tool = getTool(name);
  assert.ok(tool);
  return tool;
}
async function missing(file: string) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const caller = new Team.Member({ id: 'editor', name: 'Editor' });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('editor');
      const folder = `symlinks-${language}`;
      await fs.mkdir(folder);
      const local = (name: string) => path.join(folder, name);
      const record = (
        id: string,
        scenario: string,
        output: ToolCallOutput,
        facts: Record<string, string | number | boolean>,
      ) => {
        evidence.record({
          id: `${id}-${language}`,
          scenario,
          businessValue:
            'Let an executing agent distinguish the link path, its target and the actual filesystem effect before its next operation.',
          context: {
            language,
            scope:
              'Direct public filesystem tools, real link/target bytes on this host; no provider or browser.',
            ...facts,
          },
          reviewQuestions: [
            'Does the actual output accurately describe the observed link/target behavior, without claiming an operation on a target that was only inspected?',
            'When the link is moved, does the guidance make clear what moved and that a relative target is resolved from the new location?',
          ],
          actualText: output.content,
        });
      };

      await fs.writeFile(local('file-target.txt'), 'file-target-data\n');
      await fs.symlink('file-target.txt', local('file-link.txt'));
      const removedFile = await rmFileTool.call(dlg, caller, { path: local('file-link.txt') });
      assert.equal(removedFile.outcome, 'success');
      await missing(local('file-link.txt'));
      assert.equal(await fs.readFile(local('file-target.txt'), 'utf8'), 'file-target-data\n');
      record(
        'remove-file',
        'Remove a symlink to a file while preserving the target file and its exact bytes.',
        removedFile,
        { removedEntryIsLink: true, targetFileUnchanged: true },
      );

      await fs.mkdir(local('dir-target'));
      await fs.writeFile(local('dir-target/marker.txt'), 'directory-child-data\n');
      // Preserve the merged case's absolute-target coverage as well as relative links.
      const absoluteTarget = path.join(rtws, folder, 'dir-target');
      await fs.symlink(absoluteTarget, local('absolute-dir-link'));
      const absoluteListing = await listDirTool.call(dlg, caller, {
        path: local('absolute-dir-link'),
      });
      assert.equal(absoluteListing.outcome, 'success');
      assert.ok(absoluteListing.content.includes('marker.txt'));
      assert.ok(
        absoluteListing.content.includes(absoluteTarget),
        'the supplied target path is rendered without data loss',
      );
      assert.equal(await fs.readlink(local('absolute-dir-link')), absoluteTarget);
      await fs.symlink('dir-target', local('dir-link'));
      const listed = await listDirTool.call(dlg, caller, { path: local('dir-link') });
      assert.equal(listed.outcome, 'success');
      assert.ok(
        listed.content.includes('marker.txt'),
        'the supplied directory entry is visible through the link',
      );
      assert.equal(await fs.readlink(local('dir-link')), 'dir-target');
      record(
        'list-directory',
        'List through a directory symlink whose target contains the known marker.txt entry.',
        listed,
        { linkTarget: 'dir-target', expectedEntry: 'marker.txt', targetDirectoryUnchanged: true },
      );
      const existing = await mkDirTool.call(dlg, caller, { path: local('dir-link') });
      assert.equal(existing.outcome, 'success');
      assert.equal(toolOutputData(existing.content).created, false);
      assert.equal(toolOutputData(existing.content).path_kind, 'symlink');
      const refusedDir = await rmDirTool.call(dlg, caller, {
        path: local('dir-link'),
        recursive: false,
      });
      assert.equal(refusedDir.outcome, 'failure');
      assert.equal(await fs.readlink(local('dir-link')), 'dir-target');
      assert.equal(
        await fs.readFile(local('dir-target/marker.txt'), 'utf8'),
        'directory-child-data\n',
      );
      const removedDir = await rmDirTool.call(dlg, caller, {
        path: local('dir-link'),
        recursive: true,
      });
      assert.equal(removedDir.outcome, 'success');
      await missing(local('dir-link'));
      assert.equal(
        await fs.readFile(local('dir-target/marker.txt'), 'utf8'),
        'directory-child-data\n',
      );
      await fs.mkdir(local('empty-dir-target'));
      await fs.symlink('empty-dir-target', local('empty-dir-link'));
      const emptyRemoved = await rmDirTool.call(dlg, caller, {
        path: local('empty-dir-link'),
        recursive: false,
      });
      assert.equal(emptyRemoved.outcome, 'success');
      await missing(local('empty-dir-link'));
      assert.ok((await fs.stat(local('empty-dir-target'))).isDirectory());
      record(
        'remove-directory',
        'A nonempty directory symlink first refuses recursive=false; recursive=true removes only the link. An empty directory symlink can be removed with recursive=false. Both target directories remain.',
        {
          ...removedDir,
          content: JSON.stringify(
            {
              nonemptyRefusal: refusedDir.content,
              nonemptyRemoval: removedDir.content,
              emptyRemoval: emptyRemoved.content,
            },
            null,
            2,
          ),
        },
        {
          removedEntriesAreLinks: true,
          targetDirectoriesUnchanged: true,
          nonemptyRecursiveFalseRefused: true,
        },
      );

      await fs.writeFile(local('move-file-target.txt'), 'move-file-target-data\n');
      await fs.symlink('move-file-target.txt', local('move-file-link.txt'));
      await fs.mkdir(local('file-destination'));
      await fs.symlink('file-destination', local('file-parent-link'));
      const fileDestination = local('file-parent-link/moved.txt');
      const movedFile = await moveFileTool.call(dlg, caller, {
        from: local('move-file-link.txt'),
        to: fileDestination,
      });
      assert.equal(movedFile.outcome, 'success');
      assert.equal(toolOutputData(movedFile.content).from_path_kind, 'symlink');
      assert.equal(toolOutputData(movedFile.content).to_parent_path_kind, 'symlink');
      await missing(local('move-file-link.txt'));
      assert.ok((await fs.lstat(fileDestination)).isSymbolicLink());
      assert.equal(await fs.readlink(fileDestination), 'move-file-target.txt');
      await assert.rejects(fs.stat(fileDestination), { code: 'ENOENT' });
      assert.equal(
        await fs.readFile(local('move-file-target.txt'), 'utf8'),
        'move-file-target-data\n',
      );
      record(
        'move-file',
        'Move a relative file symlink into a different directory through a symlinked destination parent. The raw target string is unchanged and now resolves to a missing path.',
        movedFile,
        {
          movedEntryIsLink: true,
          originalTargetUnchanged: true,
          relativeTarget: 'move-file-target.txt',
          movedLinkIsBroken: true,
        },
      );

      await fs.mkdir(local('move-dir-target'));
      await fs.writeFile(local('move-dir-target/child.txt'), 'move-dir-child-data\n');
      await fs.symlink('move-dir-target', local('move-dir-link'));
      await fs.mkdir(local('dir-destination'));
      await fs.symlink('dir-destination', local('dir-parent-link'));
      const dirDestination = local('dir-parent-link/moved');
      const movedDir = await moveDirTool.call(dlg, caller, {
        from: local('move-dir-link'),
        to: dirDestination,
      });
      assert.equal(movedDir.outcome, 'success');
      const moveData = toolOutputData(movedDir.content);
      assert.equal(moveData.from_path_kind, 'symlink');
      assert.equal(moveData.to_parent_path_kind, 'symlink');
      assert.equal(moveData.moved_entry_count, 1);
      await missing(local('move-dir-link'));
      assert.ok((await fs.lstat(dirDestination)).isSymbolicLink());
      assert.equal(await fs.readlink(dirDestination), 'move-dir-target');
      await assert.rejects(fs.stat(dirDestination), { code: 'ENOENT' });
      assert.equal(
        await fs.readFile(local('move-dir-target/child.txt'), 'utf8'),
        'move-dir-child-data\n',
      );
      record(
        'move-directory',
        'Move a relative directory symlink into a different directory, preserving the raw target and original directory. The relocated link is broken; the directory tree was not moved.',
        movedDir,
        {
          movedEntryIsLink: true,
          originalTargetUnchanged: true,
          relativeTarget: 'move-dir-target',
          movedLinkIsBroken: true,
          movedEntryCount: 1,
        },
      );

      await fs.writeFile(local('explicit-target.txt'), 'explicit-target-data\n');
      const created = await createSymlinkTool.call(dlg, caller, {
        path: local('explicit-link.txt'),
        target: 'explicit-target.txt',
        symlink_type: 'file',
      });
      assert.equal(created.outcome, 'success');
      assert.equal(toolOutputData(created.content).mode, 'create_symlink');
      assert.ok((await fs.lstat(local('explicit-link.txt'))).isSymbolicLink());
      assert.equal(await fs.readlink(local('explicit-link.txt')), 'explicit-target.txt');
      const read = await readSymlinkTool.call(dlg, caller, { path: local('explicit-link.txt') });
      assert.equal(read.outcome, 'success');
      assert.equal(toolOutputData(read.content).target, 'explicit-target.txt');
      const removed = await rmSymlinkTool.call(dlg, caller, { path: local('explicit-link.txt') });
      assert.equal(removed.outcome, 'success');
      await missing(local('explicit-link.txt'));
      assert.equal(
        await fs.readFile(local('explicit-target.txt'), 'utf8'),
        'explicit-target-data\n',
      );
      await fs.symlink('missing-target.txt', local('broken-link.txt'));
      const broken = await rmSymlinkTool.call(dlg, caller, { path: local('broken-link.txt') });
      assert.equal(broken.outcome, 'success');
      await missing(local('broken-link.txt'));

      const outsidePath = path.join('..', `outside-link-${path.basename(rtws)}-${language}`);
      await missing(outsidePath);
      const denied = await createSymlinkTool.call(dlg, caller, {
        path: outsidePath,
        target: 'elsewhere.txt',
      });
      assert.equal(denied.outcome, 'failure');
      assert.equal(toolOutputData(denied.content).error, 'PATH_OUTSIDE_WORKSPACE');
      await missing(outsidePath);

      const manager = new Team.Member({ id: 'manager', name: 'Manager', toolsets: ['team_mgmt'] });
      await fs.mkdir(`.minds/links/${language}`, { recursive: true });
      await fs.writeFile(`.minds/links/${language}/target.txt`, 'team-target-data\n');
      const teamCreated = await func('team_mgmt_create_symlink').call(dlg, manager, {
        path: `links/${language}/link.txt`,
        target: 'target.txt',
        symlink_type: 'file',
      });
      assert.equal(teamCreated.outcome, 'success');
      assert.equal(await fs.readlink(`.minds/links/${language}/link.txt`), 'target.txt');
      const teamRead = await func('team_mgmt_read_symlink').call(dlg, manager, {
        path: `.minds/links/${language}/link.txt`,
      });
      assert.equal(teamRead.outcome, 'success');
      assert.equal(toolOutputData(teamRead.content).target, 'target.txt');
      const teamRemoved = await func('team_mgmt_rm_symlink').call(dlg, manager, {
        path: `links/${language}/link.txt`,
      });
      assert.equal(teamRemoved.outcome, 'success');
      await missing(`.minds/links/${language}/link.txt`);
      assert.equal(
        await fs.readFile(`.minds/links/${language}/target.txt`, 'utf8'),
        'team-target-data\n',
      );
    }
  });
  await evidence.write();
  console.log(
    'actual link-path operations, directory listing, target preservation and scoped team tools: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
