import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import '../../main/tools/builtins';

import { loadAgentMinds } from '../../main/minds/load';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import type { FuncTool } from '../../main/tool';
import { getTool } from '../../main/tools/registry';

type MinimalDialog = Readonly<{
  getLastUserLanguageCode(): 'en';
}>;

function requireFuncTool(name: string): FuncTool {
  const tool = getTool(name);
  assert.ok(tool, `${name} should exist`);
  assert.equal(tool.type, 'func');
  return tool;
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf-8');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-skills-tools-'));
  const symlinkRootTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-skills-linkable-root-'));
  const dlg: MinimalDialog = { getLastUserLanguageCode: () => 'en' };
  const alice = new Team.Member({ id: 'alice', name: 'Alice' });
  const manager = new Team.Member({ id: 'manager', name: 'Manager', toolsets: ['team_mgmt'] });

  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: test',
        '  model: test',
        'members:',
        '  alice:',
        '    name: Alice',
        'default_responder: alice',
        '',
      ].join('\n'),
    );
    await writeText(path.join(tmpRoot, '.minds', 'team', 'alice', 'persona.md'), 'persona');

    const addPersonalSkill = requireFuncTool('add_personal_skill');
    const addResult = await addPersonalSkill.call(dlg as never, alice, {
      skill_id: 'repo-debugger',
      variant: 'en',
      name: 'repo-debugger',
      description: 'Use for repository debugging.',
      body: 'Trace the failure to root cause.',
    });
    assert.equal(addResult.outcome, 'success');

    const { systemPrompt: afterPersonalAdd } = await loadAgentMinds('alice');
    assert.ok(afterPersonalAdd.includes('Use for repository debugging.'));
    assert.ok(afterPersonalAdd.includes('Trace the failure to root cause.'));
    assert.ok(
      await fs
        .stat(path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'repo-debugger'))
        .then((stat) => stat.isDirectory()),
    );

    const invalidContentResult = await addPersonalSkill.call(dlg as never, alice, {
      skill_id: 'invalid-skill',
      content: 'missing frontmatter',
    });
    assert.equal(invalidContentResult.outcome, 'failure');
    assert.ok(invalidContentResult.content.includes("frontmatter must include a non-empty 'name'"));

    const invalidMember = new Team.Member({ id: '../alice', name: 'Invalid Member' });
    const invalidMemberResult = await addPersonalSkill.call(dlg as never, invalidMember, {
      skill_id: 'unsafe',
      name: 'unsafe',
      description: 'Should not write through unsafe member id.',
      body: 'No write should happen.',
    });
    assert.equal(invalidMemberResult.outcome, 'failure');
    assert.ok(invalidMemberResult.content.includes('member_id must be one relative path segment'));

    const importPersonalSkillFromFile = requireFuncTool('import_personal_skill_from_file');
    await writeText(
      path.join(tmpRoot, 'imports', 'complete-skill.md'),
      [
        '---',
        'name: imported-complete',
        'description: Complete imported skill.',
        '---',
        '',
        'Imported complete body.',
      ].join('\n'),
    );
    const importCompleteResult = await importPersonalSkillFromFile.call(dlg as never, alice, {
      skill_id: 'imported-complete',
      source_path: 'imports/complete-skill.md',
      variant: 'en',
    });
    assert.equal(importCompleteResult.outcome, 'success');
    const importedCompleteContent = await fs.readFile(
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'imported-complete',
        'SKILL.en.md',
      ),
      'utf-8',
    );
    assert.ok(importedCompleteContent.includes('Complete imported skill.'));
    assert.ok(importedCompleteContent.includes('Imported complete body.'));

    await writeText(
      path.join(tmpRoot, 'imports', 'upstream-skill.md'),
      [
        '---',
        'name: upstream-name',
        'description: Upstream description should be replaced.',
        'unsupported: upstream-only',
        '---',
        '',
        'Keep this long adjusted body.',
      ].join('\n'),
    );
    const importRefrontmatterResult = await importPersonalSkillFromFile.call(dlg as never, alice, {
      skill_id: 'imported-adjusted',
      source_path: 'imports/upstream-skill.md',
      variant: 'en',
      replace_frontmatter: true,
      name: 'imported-adjusted',
      description: 'Adjusted imported skill.',
      allowed_tools: ['read_file'],
    });
    assert.equal(importRefrontmatterResult.outcome, 'success');
    const importedAdjustedContent = await fs.readFile(
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'imported-adjusted',
        'SKILL.en.md',
      ),
      'utf-8',
    );
    assert.ok(importedAdjustedContent.includes('name: imported-adjusted'));
    assert.ok(importedAdjustedContent.includes('description: Adjusted imported skill.'));
    assert.ok(importedAdjustedContent.includes('allowed-tools:'));
    assert.ok(importedAdjustedContent.includes('- read_file'));
    assert.ok(importedAdjustedContent.includes('Keep this long adjusted body.'));
    assert.ok(!importedAdjustedContent.includes('unsupported: upstream-only'));

    const importReplaceResult = await importPersonalSkillFromFile.call(dlg as never, alice, {
      skill_id: 'imported-adjusted',
      source_path: 'imports/complete-skill.md',
      variant: 'en',
      import_mode: 'replace',
    });
    assert.equal(importReplaceResult.outcome, 'success');
    const importedReplacedContent = await fs.readFile(
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'imported-adjusted',
        'SKILL.en.md',
      ),
      'utf-8',
    );
    assert.ok(importedReplacedContent.includes('Complete imported skill.'));
    assert.ok(!importedReplacedContent.includes('Adjusted imported skill.'));

    await writeText(
      path.join(tmpRoot, 'external-skill-files', 'variant-target.md'),
      [
        '---',
        'name: variant-target',
        'description: External variant target.',
        '---',
        '',
        'External variant body.',
      ].join('\n'),
    );
    await fs.mkdir(
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'variant-link-helper'),
      { recursive: true },
    );
    await fs.symlink(
      path.relative(
        path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'variant-link-helper'),
        path.join(tmpRoot, 'external-skill-files', 'variant-target.md'),
      ),
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'variant-link-helper',
        'SKILL.en.md',
      ),
    );
    const importOverVariantSymlinkResult = await importPersonalSkillFromFile.call(
      dlg as never,
      alice,
      {
        skill_id: 'variant-link-helper',
        source_path: 'imports/complete-skill.md',
        variant: 'en',
        import_mode: 'replace',
      },
    );
    assert.equal(importOverVariantSymlinkResult.outcome, 'success');
    const materializedVariantPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'variant-link-helper',
      'SKILL.en.md',
    );
    assert.equal((await fs.lstat(materializedVariantPath)).isSymbolicLink(), false);
    const externalVariantContent = await fs.readFile(
      path.join(tmpRoot, 'external-skill-files', 'variant-target.md'),
      'utf-8',
    );
    assert.ok(externalVariantContent.includes('External variant target.'));
    assert.ok(!externalVariantContent.includes('Complete imported skill.'));

    const invalidFullImportResult = await importPersonalSkillFromFile.call(dlg as never, alice, {
      skill_id: 'invalid-full-import',
      source_path: 'imports/upstream-skill.md',
      variant: 'en',
    });
    assert.equal(invalidFullImportResult.outcome, 'failure');
    assert.ok(invalidFullImportResult.content.includes("unsupported key 'unsupported'"));

    const outsideImportResult = await importPersonalSkillFromFile.call(dlg as never, alice, {
      skill_id: 'outside-import',
      source_path: '../outside-skill.md',
      variant: 'en',
    });
    assert.equal(outsideImportResult.outcome, 'failure');
    assert.ok(outsideImportResult.content.includes('source_path must be within rtws'));

    const restrictedReader = new Team.Member({
      id: 'restricted',
      name: 'Restricted',
      read_dirs: ['other/**'],
    });
    const deniedImportResult = await importPersonalSkillFromFile.call(
      dlg as never,
      restrictedReader,
      {
        skill_id: 'denied-import',
        source_path: 'imports/complete-skill.md',
        variant: 'en',
      },
    );
    assert.equal(deniedImportResult.outcome, 'failure');
    assert.ok(deniedImportResult.content.includes('Access Denied'));

    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'release-helper', 'SKILL.en.md'),
      [
        '---',
        'name: release-helper',
        'description: Team-managed release guidance.',
        '---',
        '',
        'Check release blockers before handoff.',
      ].join('\n'),
    );

    const { systemPrompt: beforeLink } = await loadAgentMinds('alice');
    assert.ok(!beforeLink.includes('Team-managed release guidance.'));

    const linkSkill = requireFuncTool('team_mgmt_link_skill');
    const linkResult = await linkSkill.call(dlg as never, manager, {
      member_id: 'alice',
      skill_id: 'release-helper',
    });
    assert.equal(linkResult.outcome, 'success');

    const linkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'release-helper',
    );
    assert.equal((await fs.lstat(linkedPath)).isSymbolicLink(), true);
    const { systemPrompt: afterLink } = await loadAgentMinds('alice');
    assert.ok(afterLink.includes('Team-managed release guidance.'));
    assert.ok(afterLink.includes('Check release blockers before handoff.'));

    const replacedLinkedSkill = await requireFuncTool('replace_personal_skill').call(
      dlg as never,
      alice,
      {
        skill_id: 'release-helper',
        variant: 'en',
        name: 'release-helper',
        description: 'Alice-local release guidance.',
        body: 'This is Alice-local after copy-on-write.',
      },
    );
    assert.equal(replacedLinkedSkill.outcome, 'success');
    assert.equal((await fs.lstat(linkedPath)).isDirectory(), true);
    assert.equal((await fs.lstat(linkedPath)).isSymbolicLink(), false);
    const linkedTargetContent = await fs.readFile(
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'release-helper', 'SKILL.en.md'),
      'utf-8',
    );
    assert.ok(linkedTargetContent.includes('Team-managed release guidance.'));
    assert.ok(!linkedTargetContent.includes('Alice-local release guidance.'));
    const aliceLocalContent = await fs.readFile(path.join(linkedPath, 'SKILL.en.md'), 'utf-8');
    assert.ok(aliceLocalContent.includes('Alice-local release guidance.'));
    assert.ok(aliceLocalContent.includes('This is Alice-local after copy-on-write.'));

    await writeText(
      path.join(tmpRoot, 'external-skill-files', 'deep-helper.en.md'),
      [
        '---',
        'name: deep-helper',
        'description: External deep-linked helper.',
        '---',
        '',
        'External deep-linked body.',
      ].join('\n'),
    );
    await fs.mkdir(path.join(tmpRoot, '.minds', 'skills', 'linkable', 'deep-helper'), {
      recursive: true,
    });
    await fs.symlink(
      path.relative(
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'deep-helper'),
        path.join(tmpRoot, 'external-skill-files', 'deep-helper.en.md'),
      ),
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'deep-helper', 'SKILL.en.md'),
    );
    const deepLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'deep-helper',
    );
    await fs.symlink(
      path.relative(
        path.dirname(deepLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'deep-helper'),
      ),
      deepLinkedPath,
    );
    const replacedDeepLinkedSkill = await requireFuncTool('replace_personal_skill').call(
      dlg as never,
      alice,
      {
        skill_id: 'deep-helper',
        variant: 'en',
        name: 'deep-helper',
        description: 'Alice-local deep helper.',
        body: 'Local deep helper after copy-on-write.',
      },
    );
    assert.equal(replacedDeepLinkedSkill.outcome, 'success');
    assert.equal((await fs.lstat(deepLinkedPath)).isSymbolicLink(), false);
    assert.equal(
      (await fs.lstat(path.join(deepLinkedPath, 'SKILL.en.md'))).isSymbolicLink(),
      false,
    );
    const externalDeepLinkedContent = await fs.readFile(
      path.join(tmpRoot, 'external-skill-files', 'deep-helper.en.md'),
      'utf-8',
    );
    assert.ok(externalDeepLinkedContent.includes('External deep-linked helper.'));
    assert.ok(!externalDeepLinkedContent.includes('Alice-local deep helper.'));

    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'cycle-helper', 'SKILL.en.md'),
      ['---', 'name: cycle-helper', 'description: Cyclic helper.', '---', '', 'Cycle body.'].join(
        '\n',
      ),
    );
    await fs.symlink(
      '.',
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'cycle-helper', 'self'),
    );
    const cycleLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'cycle-helper',
    );
    await fs.symlink(
      path.relative(
        path.dirname(cycleLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'cycle-helper'),
      ),
      cycleLinkedPath,
    );
    const cycleReplaceResult = await requireFuncTool('replace_personal_skill').call(
      dlg as never,
      alice,
      {
        skill_id: 'cycle-helper',
        variant: 'en',
        name: 'cycle-helper',
        description: 'Should fail loudly on copy cycles.',
        body: 'No partial materialization.',
      },
    );
    assert.equal(cycleReplaceResult.outcome, 'failure');
    assert.ok(cycleReplaceResult.content.includes('Symlink cycle detected'));
    assert.equal((await fs.lstat(cycleLinkedPath)).isSymbolicLink(), true);
    await fs.unlink(cycleLinkedPath);

    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'review-helper', 'SKILL.en.md'),
      [
        '---',
        'name: review-helper',
        'description: Team-managed review guidance.',
        '---',
        '',
        'Review carefully.',
      ].join('\n'),
    );
    const reviewLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'review-helper',
    );
    await fs.symlink(
      path.relative(
        path.dirname(reviewLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'review-helper'),
      ),
      reviewLinkedPath,
    );
    const addedVariantToLinkedSkill = await addPersonalSkill.call(dlg as never, alice, {
      skill_id: 'review-helper',
      variant: 'neutral',
      name: 'review-helper-local',
      description: 'Alice-local neutral review helper.',
      body: 'Local neutral variant after copy-on-write.',
    });
    assert.equal(addedVariantToLinkedSkill.outcome, 'success');
    assert.equal((await fs.lstat(reviewLinkedPath)).isSymbolicLink(), false);
    assert.ok(await exists(path.join(reviewLinkedPath, 'SKILL.md')));
    assert.equal(
      await exists(path.join(tmpRoot, '.minds', 'skills', 'linkable', 'review-helper', 'SKILL.md')),
      false,
      'add_personal_skill must not write through linked team package',
    );

    const deleteLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'delete-helper',
    );
    await fs.symlink(
      path.relative(
        path.dirname(deleteLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'release-helper'),
      ),
      deleteLinkedPath,
    );
    const dropLinkedSkill = await requireFuncTool('drop_personal_skill').call(dlg as never, alice, {
      skill_id: 'delete-helper',
    });
    assert.equal(dropLinkedSkill.outcome, 'success');
    assert.equal(
      await exists(deleteLinkedPath),
      false,
      'drop should remove the current member personal symlink itself',
    );
    const deleteLinkedTargetContent = await fs.readFile(
      path.join(tmpRoot, '.minds', 'skills', 'linkable', 'release-helper', 'SKILL.en.md'),
      'utf-8',
    );
    assert.ok(deleteLinkedTargetContent.includes('Team-managed release guidance.'));

    const brokenWriteLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'broken-write-helper',
    );
    await fs.symlink('../missing-write-helper', brokenWriteLinkedPath);
    const brokenWriteResult = await requireFuncTool('replace_personal_skill').call(
      dlg as never,
      alice,
      {
        skill_id: 'broken-write-helper',
        variant: 'en',
        name: 'broken-write-helper',
        description: 'Must not overwrite broken links silently.',
        body: 'No silent repair.',
      },
    );
    assert.equal(brokenWriteResult.outcome, 'failure');
    assert.ok(brokenWriteResult.content.includes('copy-on-write failed'));
    assert.ok(!brokenWriteResult.content.includes('EEXIST'));
    assert.equal((await fs.lstat(brokenWriteLinkedPath)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(brokenWriteLinkedPath), '../missing-write-helper');
    await fs.unlink(brokenWriteLinkedPath);

    const dropMaterializedLinkedSkill = await requireFuncTool('drop_personal_skill').call(
      dlg as never,
      alice,
      { skill_id: 'release-helper' },
    );
    assert.equal(dropMaterializedLinkedSkill.outcome, 'success');
    assert.equal(
      await exists(linkedPath),
      false,
      'drop should remove an owned materialized skill package',
    );
    assert.equal(await exists(deleteLinkedPath), false);

    const brokenVariantDropSkillDir = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'broken-variant-drop-helper',
    );
    await fs.mkdir(brokenVariantDropSkillDir, { recursive: true });
    const brokenVariantPath = path.join(brokenVariantDropSkillDir, 'SKILL.en.md');
    await fs.symlink('../missing-variant-target.md', brokenVariantPath);
    const dropBrokenVariantLink = await requireFuncTool('drop_personal_skill').call(
      dlg as never,
      alice,
      { skill_id: 'broken-variant-drop-helper', variant: 'en' },
    );
    assert.equal(dropBrokenVariantLink.outcome, 'success');
    assert.equal(
      await exists(brokenVariantPath),
      false,
      'drop variant should remove the personal symlink itself even when its target is missing',
    );

    const unlinkSkill = requireFuncTool('team_mgmt_unlink_skill');
    await fs.symlink(
      path.relative(
        path.dirname(deleteLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'release-helper'),
      ),
      deleteLinkedPath,
    );
    const unlinkResult = await unlinkSkill.call(dlg as never, manager, {
      member_id: 'alice',
      skill_id: 'delete-helper',
    });
    assert.equal(unlinkResult.outcome, 'success');
    await assert.rejects(fs.lstat(deleteLinkedPath), /ENOENT/);

    const escapingLinkablePath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'linkable',
      'escaping-helper',
    );
    await fs.symlink(
      path.relative(path.dirname(escapingLinkablePath), tmpRoot),
      escapingLinkablePath,
    );
    const escapingLinkResult = await linkSkill.call(dlg as never, manager, {
      member_id: 'alice',
      skill_id: 'escaping-helper',
    });
    assert.equal(escapingLinkResult.outcome, 'success');
    const escapingPersonalLinkPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'escaping-helper',
    );
    assert.equal((await fs.lstat(escapingPersonalLinkPath)).isSymbolicLink(), true);
    await fs.unlink(escapingPersonalLinkPath);
    await fs.unlink(escapingLinkablePath);

    const invalidLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'outside-link',
    );
    await fs.symlink(path.relative(path.dirname(invalidLinkedPath), tmpRoot), invalidLinkedPath);
    const { systemPrompt: withOutsideLink } = await loadAgentMinds('alice');
    assert.ok(!withOutsideLink.includes('Team-managed release guidance.'));
    await fs.unlink(invalidLinkedPath);

    const rootLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'root-link',
    );
    await fs.symlink(
      path.relative(
        path.dirname(rootLinkedPath),
        path.join(tmpRoot, '.minds', 'skills', 'linkable'),
      ),
      rootLinkedPath,
    );
    await loadAgentMinds('alice');
    await fs.unlink(rootLinkedPath);

    await writeText(
      path.join(tmpRoot, 'external-skill-files', 'variant-load-target.md'),
      [
        '---',
        'name: variant-load-target',
        'description: Variant file symlink loads.',
        '---',
        '',
        'Variant symlink body.',
      ].join('\n'),
    );
    await fs.mkdir(
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'variant-load-helper'),
      { recursive: true },
    );
    await fs.symlink(
      path.relative(
        path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'variant-load-helper'),
        path.join(tmpRoot, 'external-skill-files', 'variant-load-target.md'),
      ),
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'variant-load-helper',
        'SKILL.en.md',
      ),
    );
    const { systemPrompt: withVariantFileSymlink } = await loadAgentMinds('alice');
    assert.ok(withVariantFileSymlink.includes('Variant file symlink loads.'));
    assert.ok(withVariantFileSymlink.includes('Variant symlink body.'));

    await fs.mkdir(
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'broken-variant-helper'),
      { recursive: true },
    );
    await fs.symlink(
      '../missing-variant-target.md',
      path.join(
        tmpRoot,
        '.minds',
        'skills',
        'individual',
        'alice',
        'broken-variant-helper',
        'SKILL.en.md',
      ),
    );
    await assert.rejects(
      loadAgentMinds('alice'),
      /Invalid skill symlink '.minds\/skills\/individual\/alice\/broken-variant-helper\/SKILL.en.md': target does not exist/,
    );
    await fs.rm(
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'broken-variant-helper'),
      {
        recursive: true,
        force: false,
      },
    );

    const brokenLinkedPath = path.join(
      tmpRoot,
      '.minds',
      'skills',
      'individual',
      'alice',
      'broken-link',
    );
    await fs.symlink('../missing-linkable-package', brokenLinkedPath);
    await assert.rejects(
      loadAgentMinds('alice'),
      /Invalid skill symlink '.minds\/skills\/individual\/alice\/broken-link': target does not exist/,
    );

    await fs.unlink(brokenLinkedPath);
    await fs.rm(path.join(tmpRoot, '.minds', 'skills', 'linkable'), {
      recursive: true,
      force: false,
    });
    await writeText(
      path.join(symlinkRootTmp, 'external-helper', 'SKILL.en.md'),
      [
        '---',
        'name: external-helper',
        'description: External helper should not be linkable.',
        '---',
        '',
        'No external linkable root.',
      ].join('\n'),
    );
    await fs.symlink(
      path.relative(path.join(tmpRoot, '.minds', 'skills'), symlinkRootTmp),
      path.join(tmpRoot, '.minds', 'skills', 'linkable'),
    );
    await fs.symlink(
      path.relative(
        path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice'),
        path.join(tmpRoot, '.minds', 'skills', 'linkable', 'external-helper'),
      ),
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'external-helper'),
    );
    const { systemPrompt: withSymlinkedLinkableRoot } = await loadAgentMinds('alice');
    assert.ok(withSymlinkedLinkableRoot.includes('External helper should not be linkable.'));

    console.log('✅ skills-tools tests: ok');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(symlinkRootTmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('❌ skills-tools test failed', err);
  process.exit(1);
});
