import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMarkdownFrontmatter } from '../../main/markdown/frontmatter';
import { loadAgentMinds } from '../../main/minds/load';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { loadWorkspaceSkills, renderWorkspaceSkillsPrompt } from '../../main/skills/load';
import { Team } from '../../main/team';
import type { ToolArguments } from '../../main/tool';
import '../../main/tools/builtins';
import { getTool } from '../../main/tools/registry';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-skill-tools-');
async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
/** Snapshot owned package bytes and link targets without following cycles or external links. */
async function tree(root: string) {
  const entries: Array<{ path: string; kind: string; data?: string; target?: string }> = [];
  async function visit(file: string, relative: string) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink())
      entries.push({ path: relative, kind: 'link', target: await fs.readlink(file) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      for (const name of (await fs.readdir(file)).sort())
        await visit(path.join(file, name), relative ? relative + '/' + name : name);
    } else
      entries.push({
        path: relative,
        kind: 'file',
        data: (await fs.readFile(file)).toString('base64'),
      });
  }
  if (await exists(root)) await visit(root, '');
  return entries;
}
function markdown(name: string, description: string, body: string) {
  return ['---', 'name: ' + name, 'description: ' + description, '---', '', body].join('\n');
}
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['alice', 'manager', 'restricted'] });
    setWorkLanguage('en');
    const dialog = await createMainDialog('alice');
    dialog.setLastUserLanguageCode('en');
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      toolsets: ['skills'],
      read_dirs: ['**'],
    });
    const manager = new Team.Member({ id: 'manager', name: 'Manager', toolsets: ['team_mgmt'] });
    const restricted = new Team.Member({
      id: 'restricted',
      name: 'Restricted',
      read_dirs: ['other/**'],
    });
    const skillsRoot = path.join(rtws, '.minds', 'skills');
    const personal = path.join(skillsRoot, 'individual', 'alice');
    const linkable = path.join(skillsRoot, 'linkable');
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-owned-skills-external-'));
    console.log(JSON.stringify({ artifact: 'owned-external-skill-input', path: external }));
    const sourceInputs = new Map<string, string>();
    async function seed(file: string, value: string) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, value);
      sourceInputs.set(file, value);
    }
    async function invoke(name: string, caller: Team.Member, args: ToolArguments) {
      const tool = getTool(name);
      assert.ok(tool && tool.type === 'func');
      const before = await tree(skillsRoot);
      const result = await tool.call(dialog, caller, args);
      if (result.outcome === 'failure') {
        assert.deepEqual(
          await tree(skillsRoot),
          before,
          'a rejected skill mutation preserves every owned package and link',
        );
        const source =
          typeof args.source_path === 'string'
            ? sourceInputs.get(path.resolve(rtws, args.source_path))
            : undefined;
        evidence.record({
          id: 'rejected-' + name + '-' + failureNumber++,
          scenario: name + ' rejects the supplied request.',
          businessValue:
            'A caller can repair the request while existing skill data and linked upstream content remain intact.',
          context: {
            caller: caller.id,
            args: JSON.stringify(args),
            sourceInput: source ?? 'not a file-import scenario',
            ownedSkillEntries: JSON.stringify(
              before.map((e) => ({ path: e.path, kind: e.kind, target: e.target })),
            ),
            skillTreeUnchanged: true,
            scope:
              'Direct handler and real filesystem; tool availability/driver authorization are separate.',
          },
          reviewQuestions: [
            'Does the full diagnostic accurately identify the supplied invalid field, missing/conflicting package, denied source or linked-target failure?',
            'Is recovery advice consistent with the unchanged files and links?',
          ],
          actualText: result.content,
        });
      }
      return result;
    }
    let failureNumber = 0;
    const catalog = () =>
      loadWorkspaceSkills({
        rtwsRootAbs: rtws,
        memberId: 'alice',
        language: 'en',
        visibleMcpServerIds: new Set(),
      });
    async function checkSkill(id: string, title: string, description: string, body: string) {
      const skill = (await catalog()).find((s) => s.id === id);
      assert.ok(skill);
      assert.equal(skill.scope, 'individual');
      assert.equal(skill.title, title);
      assert.equal(skill.description, description);
      assert.equal(skill.body, body);
      return skill;
    }
    async function guide(id: string, selectedId: string, description: string, body: string) {
      const skills = await catalog();
      assert.ok(skills.some((s) => s.id === selectedId));
      const { systemPrompt, agentTools } = await loadAgentMinds('alice', dialog);
      assert.ok(
        systemPrompt.includes(description),
        'the exact supplied description is in the assembled prompt',
      );
      assert.equal(
        systemPrompt.includes(body),
        false,
        'the exact supplied body is loaded on demand',
      );
      const read = await invoke('read_skill', alice, { skill_id: selectedId });
      assert.equal(read.outcome, 'success');
      assert.ok(read.content.includes(body), 'read_skill returns the complete supplied body');
      evidence.record({
        id,
        scenario: 'The current skill catalog is exposed after a real package operation.',
        businessValue:
          'An agent can choose the correct current skill ID and load its body only when needed, with metadata kept distinct from tool authorization.',
        context: {
          language: 'en',
          selectedId,
          catalog: JSON.stringify(skills),
          actualVisibleToolIds: JSON.stringify(agentTools.map((tool) => tool.name).sort()),
          scope:
            'Actual public catalog-guidance component, plus given-data fidelity in loadAgentMinds/read_skill; not every surrounding persona paragraph. Supplied descriptions/bodies are untrusted fixture data, not Dominds policy.',
        },
        reviewQuestions: [
          'Does the generated guidance offer usable read_skill calls for the actual IDs, including renamed/linked entries?',
          'Does it distinguish a summary from the body and avoid treating advisory allowed-tools as a grant?',
        ],
        actualText: renderWorkspaceSkillsPrompt({ language: 'en', skills }),
      });
    }
    const initial = {
      name: 'repo-debugger',
      description: 'Use for repository debugging.',
      body: 'Trace the failure to root cause.',
    };
    assert.equal(
      (
        await invoke('add_personal_skill', alice, {
          skill_id: 'repo-debugger',
          variant: 'en',
          ...initial,
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.stat(path.join(personal, 'repo-debugger'))).isDirectory(), true);
    await checkSkill('repo-debugger', initial.name, initial.description, initial.body);
    await guide('personal-catalog', 'repo-debugger', initial.description, initial.body);
    assert.equal(
      (
        await invoke('add_personal_skill', alice, {
          skill_id: 'invalid-skill',
          content: 'missing frontmatter',
        })
      ).outcome,
      'failure',
    );
    assert.equal(
      (
        await invoke('add_personal_skill', new Team.Member({ id: '../alice', name: 'Invalid' }), {
          skill_id: 'unsafe',
          name: 'unsafe',
          description: 'Should not write through unsafe member id.',
          body: 'No write should happen.',
        })
      ).outcome,
      'failure',
    );

    const complete = markdown(
      'imported-complete',
      'Complete imported skill.',
      'Imported complete body.',
    );
    const completeSource = path.join(rtws, 'imports', 'complete-skill.md');
    await seed(completeSource, complete);
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', alice, {
          skill_id: 'imported-complete',
          source_path: 'imports/complete-skill.md',
          variant: 'en',
        })
      ).outcome,
      'success',
    );
    const importedPath = path.join(personal, 'imported-complete', 'SKILL.en.md');
    assert.equal(await fs.readFile(importedPath, 'utf8'), complete + '\n');
    const importedBefore = await tree(path.join(personal, 'imported-complete'));
    const moved = await invoke('move_personal_skill', alice, {
      from_skill_id: 'imported-complete',
      to_skill_id: 'renamed-complete',
    });
    assert.equal(moved.outcome, 'success');
    assert.equal(await exists(path.join(personal, 'imported-complete')), false);
    assert.deepEqual(await tree(path.join(personal, 'renamed-complete')), importedBefore);
    assert.equal(
      (await catalog()).some((s) => s.id === 'imported-complete'),
      false,
    );
    await checkSkill(
      'renamed-complete',
      'imported-complete',
      'Complete imported skill.',
      'Imported complete body.',
    );
    await guide(
      'renamed-catalog',
      'renamed-complete',
      'Complete imported skill.',
      'Imported complete body.',
    );
    evidence.record({
      id: 'move-receipt',
      scenario:
        'The personal package was renamed while every file byte and the original frontmatter name were preserved.',
      businessValue:
        'The agent must use the new skill_id without believing the frontmatter title was rewritten.',
      context: {
        from_skill_id: 'imported-complete',
        to_skill_id: 'renamed-complete',
        frontmatterName: 'imported-complete',
        wholePackagePreserved: true,
      },
      reviewQuestions: [
        'Does the complete receipt accurately distinguish package ID and frontmatter name?',
      ],
      actualText: moved.content,
    });
    for (const args of [
      { from_skill_id: 'missing-skill', to_skill_id: 'still-missing' },
      { from_skill_id: 'renamed-complete', to_skill_id: 'repo-debugger' },
      { from_skill_id: 'renamed-complete', to_skill_id: 'renamed-complete' },
      { from_skill_id: 'renamed-complete', to_skill_id: '../unsafe' },
    ])
      assert.equal((await invoke('move_personal_skill', alice, args)).outcome, 'failure');
    await seed(path.join(personal, 'not-a-package'), 'not a skill directory package');
    assert.equal(
      (
        await invoke('move_personal_skill', alice, {
          from_skill_id: 'not-a-package',
          to_skill_id: 'still-not-a-package',
        })
      ).outcome,
      'failure',
    );

    const upstream = [
      '---',
      'name: upstream-name',
      'description: Upstream description should be replaced.',
      'unsupported: upstream-only',
      '---',
      '',
      'Keep this long adjusted body.',
    ].join('\n');
    await seed(path.join(rtws, 'imports', 'upstream-skill.md'), upstream);
    const grantsBefore = (await loadAgentMinds('alice', dialog)).agentTools
      .map((tool) => tool.name)
      .sort();
    assert.equal(
      grantsBefore.includes('read_file'),
      false,
      'the advisory tool is not already visible in the actual assembled harness',
    );
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', alice, {
          skill_id: 'imported-adjusted',
          source_path: 'imports/upstream-skill.md',
          variant: 'en',
          replace_frontmatter: true,
          name: 'imported-adjusted',
          description: 'Adjusted imported skill.',
          allowed_tools: ['read_file'],
        })
      ).outcome,
      'success',
    );
    const adjustedPath = path.join(personal, 'imported-adjusted', 'SKILL.en.md');
    const adjusted = parseMarkdownFrontmatter(await fs.readFile(adjustedPath, 'utf8'));
    assert.deepEqual(adjusted.frontmatter, {
      name: 'imported-adjusted',
      description: 'Adjusted imported skill.',
      'allowed-tools': ['read_file'],
    });
    assert.equal(adjusted.body.trim(), 'Keep this long adjusted body.');
    assert.deepEqual(
      (await loadAgentMinds('alice', dialog)).agentTools.map((tool) => tool.name).sort(),
      grantsBefore,
    );
    assert.deepEqual(
      (
        await checkSkill(
          'imported-adjusted',
          'imported-adjusted',
          'Adjusted imported skill.',
          'Keep this long adjusted body.',
        )
      ).declaredAllowedTools,
      ['read_file'],
    );
    await guide(
      'advisory-metadata-catalog',
      'imported-adjusted',
      'Adjusted imported skill.',
      'Keep this long adjusted body.',
    );
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', alice, {
          skill_id: 'imported-adjusted',
          source_path: 'imports/complete-skill.md',
          variant: 'en',
          import_mode: 'replace',
        })
      ).outcome,
      'success',
    );
    assert.equal(await fs.readFile(adjustedPath, 'utf8'), complete + '\n');

    const variantSource = path.join(rtws, 'external-skill-files', 'variant-target.md');
    const variantOriginal = markdown(
      'variant-target',
      'External variant target.',
      'External variant body.',
    );
    await seed(variantSource, variantOriginal);
    const variantPackage = path.join(personal, 'variant-link-helper');
    await fs.mkdir(variantPackage, { recursive: true });
    const variantLink = path.join(variantPackage, 'SKILL.en.md');
    await fs.symlink(path.relative(variantPackage, variantSource), variantLink);
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', alice, {
          skill_id: 'variant-link-helper',
          source_path: 'imports/complete-skill.md',
          variant: 'en',
          import_mode: 'replace',
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.lstat(variantLink)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(variantLink, 'utf8'), complete + '\n');
    assert.equal(await fs.readFile(variantSource, 'utf8'), variantOriginal);
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', alice, {
          skill_id: 'invalid-full-import',
          source_path: 'imports/upstream-skill.md',
          variant: 'en',
        })
      ).outcome,
      'failure',
    );
    const outsideSource = path.join(external, 'outside-skill.md');
    const outsideBody = 'owned-outside-skill-body-data';
    const outsideMarkdown = markdown('outside', 'Owned outside source.', outsideBody);
    await seed(outsideSource, outsideMarkdown);
    const outside = await invoke('import_personal_skill_from_file', alice, {
      skill_id: 'outside-import',
      source_path: path.relative(rtws, outsideSource),
      variant: 'en',
    });
    assert.equal(outside.outcome, 'failure');
    assert.equal(outside.content.includes(outsideBody), false);
    assert.equal(await fs.readFile(outsideSource, 'utf8'), outsideMarkdown);
    assert.equal(
      (
        await invoke('import_personal_skill_from_file', restricted, {
          skill_id: 'denied-import',
          source_path: 'imports/complete-skill.md',
          variant: 'en',
        })
      ).outcome,
      'failure',
    );
    assert.equal(await fs.readFile(completeSource, 'utf8'), complete);

    const release = markdown(
      'release-helper',
      'Team-managed release guidance.',
      'Check release blockers before handoff.',
    );
    await seed(path.join(linkable, 'release-helper', 'SKILL.en.md'), release);
    assert.equal(
      (await catalog()).some((s) => s.id === 'release-helper'),
      false,
    );
    const releasePackage = path.join(personal, 'release-helper');
    assert.equal(
      (
        await invoke('team_mgmt_link_skill', manager, {
          member_id: 'alice',
          skill_id: 'release-helper',
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.lstat(releasePackage)).isSymbolicLink(), true);
    assert.equal(
      await fs.realpath(releasePackage),
      await fs.realpath(path.join(linkable, 'release-helper')),
    );
    await checkSkill(
      'release-helper',
      'release-helper',
      'Team-managed release guidance.',
      'Check release blockers before handoff.',
    );
    await guide(
      'linked-catalog',
      'release-helper',
      'Team-managed release guidance.',
      'Check release blockers before handoff.',
    );
    const teamBefore = await tree(linkable);
    assert.equal(
      (
        await invoke('replace_personal_skill', alice, {
          skill_id: 'release-helper',
          variant: 'en',
          name: 'release-helper',
          description: 'Alice-local release guidance.',
          body: 'This is Alice-local after copy-on-write.',
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.lstat(releasePackage)).isDirectory(), true);
    assert.equal((await fs.lstat(releasePackage)).isSymbolicLink(), false);
    assert.deepEqual(await tree(linkable), teamBefore);
    await checkSkill(
      'release-helper',
      'release-helper',
      'Alice-local release guidance.',
      'This is Alice-local after copy-on-write.',
    );
    await guide(
      'materialized-personal-catalog',
      'release-helper',
      'Alice-local release guidance.',
      'This is Alice-local after copy-on-write.',
    );

    const deepSource = path.join(rtws, 'external-skill-files', 'deep-helper.en.md');
    const deepOriginal = markdown(
      'deep-helper',
      'External deep-linked helper.',
      'External deep-linked body.',
    );
    await seed(deepSource, deepOriginal);
    const deepTeam = path.join(linkable, 'deep-helper');
    await fs.mkdir(deepTeam, { recursive: true });
    await fs.symlink(path.relative(deepTeam, deepSource), path.join(deepTeam, 'SKILL.en.md'));
    const deepPersonal = path.join(personal, 'deep-helper');
    await fs.symlink(path.relative(personal, deepTeam), deepPersonal);
    const deepBefore = await tree(deepTeam);
    assert.equal(
      (
        await invoke('replace_personal_skill', alice, {
          skill_id: 'deep-helper',
          variant: 'en',
          name: 'deep-helper',
          description: 'Alice-local deep helper.',
          body: 'Local deep helper after copy-on-write.',
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.lstat(deepPersonal)).isSymbolicLink(), false);
    assert.equal((await fs.lstat(path.join(deepPersonal, 'SKILL.en.md'))).isSymbolicLink(), false);
    assert.deepEqual(await tree(deepTeam), deepBefore);
    assert.equal(await fs.readFile(deepSource, 'utf8'), deepOriginal);
    await checkSkill(
      'deep-helper',
      'deep-helper',
      'Alice-local deep helper.',
      'Local deep helper after copy-on-write.',
    );

    await seed(
      path.join(linkable, 'cycle-helper', 'SKILL.en.md'),
      markdown('cycle-helper', 'Cyclic helper.', 'Cycle body.'),
    );
    await fs.symlink('.', path.join(linkable, 'cycle-helper', 'self'));
    const cyclePersonal = path.join(personal, 'cycle-helper');
    await fs.symlink(path.relative(personal, path.join(linkable, 'cycle-helper')), cyclePersonal);
    assert.equal(
      (
        await invoke('replace_personal_skill', alice, {
          skill_id: 'cycle-helper',
          variant: 'en',
          name: 'cycle-helper',
          description: 'Should fail loudly on copy cycles.',
          body: 'No partial materialization.',
        })
      ).outcome,
      'failure',
    );
    assert.equal((await fs.lstat(cyclePersonal)).isSymbolicLink(), true);
    await fs.unlink(cyclePersonal);

    const reviewOriginal = markdown(
      'review-helper',
      'Team-managed review guidance.',
      'Review carefully.',
    );
    await seed(path.join(linkable, 'review-helper', 'SKILL.en.md'), reviewOriginal);
    const reviewPersonal = path.join(personal, 'review-helper');
    await fs.symlink(path.relative(personal, path.join(linkable, 'review-helper')), reviewPersonal);
    const reviewBefore = await tree(path.join(linkable, 'review-helper'));
    assert.equal(
      (
        await invoke('add_personal_skill', alice, {
          skill_id: 'review-helper',
          variant: 'neutral',
          name: 'review-helper-local',
          description: 'Alice-local neutral review helper.',
          body: 'Local neutral variant after copy-on-write.',
        })
      ).outcome,
      'success',
    );
    assert.equal((await fs.lstat(reviewPersonal)).isSymbolicLink(), false);
    assert.ok(await exists(path.join(reviewPersonal, 'SKILL.md')));
    assert.equal(
      await fs.readFile(path.join(reviewPersonal, 'SKILL.en.md'), 'utf8'),
      reviewOriginal,
    );
    assert.deepEqual(await tree(path.join(linkable, 'review-helper')), reviewBefore);

    const deletePersonal = path.join(personal, 'delete-helper');
    await fs.symlink(
      path.relative(personal, path.join(linkable, 'release-helper')),
      deletePersonal,
    );
    const releaseBeforeDelete = await tree(path.join(linkable, 'release-helper'));
    assert.equal(
      (await invoke('drop_personal_skill', alice, { skill_id: 'delete-helper' })).outcome,
      'success',
    );
    assert.equal(await exists(deletePersonal), false);
    assert.deepEqual(await tree(path.join(linkable, 'release-helper')), releaseBeforeDelete);
    const moveLink = path.join(personal, 'move-link-helper'),
      movedLink = path.join(personal, 'moved-link-helper');
    const linkTarget = path.relative(personal, path.join(linkable, 'release-helper'));
    await fs.symlink(linkTarget, moveLink);
    assert.equal(
      (
        await invoke('move_personal_skill', alice, {
          from_skill_id: 'move-link-helper',
          to_skill_id: 'moved-link-helper',
        })
      ).outcome,
      'success',
    );
    assert.equal(await exists(moveLink), false);
    assert.equal((await fs.lstat(movedLink)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(movedLink), linkTarget);
    assert.deepEqual(await tree(path.join(linkable, 'release-helper')), releaseBeforeDelete);
    await fs.unlink(movedLink);
    const brokenMove = path.join(personal, 'broken-move-helper'),
      movedBroken = path.join(personal, 'moved-broken-move-helper');
    await fs.symlink('../missing-move-helper', brokenMove);
    assert.equal(
      (
        await invoke('move_personal_skill', alice, {
          from_skill_id: 'broken-move-helper',
          to_skill_id: 'moved-broken-move-helper',
        })
      ).outcome,
      'success',
    );
    assert.equal(await exists(brokenMove), false);
    assert.equal((await fs.lstat(movedBroken)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(movedBroken), '../missing-move-helper');
    await fs.unlink(movedBroken);
    const brokenWrite = path.join(personal, 'broken-write-helper');
    await fs.symlink('../missing-write-helper', brokenWrite);
    assert.equal(
      (
        await invoke('replace_personal_skill', alice, {
          skill_id: 'broken-write-helper',
          variant: 'en',
          name: 'broken-write-helper',
          description: 'Must not overwrite broken links silently.',
          body: 'No silent repair.',
        })
      ).outcome,
      'failure',
    );
    assert.equal(await fs.readlink(brokenWrite), '../missing-write-helper');
    await fs.unlink(brokenWrite);
    assert.equal(
      (await invoke('drop_personal_skill', alice, { skill_id: 'release-helper' })).outcome,
      'success',
    );
    assert.equal(await exists(releasePackage), false);
    assert.deepEqual(await tree(path.join(linkable, 'release-helper')), releaseBeforeDelete);
    const brokenVariantDir = path.join(personal, 'broken-variant-drop-helper');
    await fs.mkdir(brokenVariantDir, { recursive: true });
    const brokenVariant = path.join(brokenVariantDir, 'SKILL.en.md');
    await fs.symlink('../missing-variant-target.md', brokenVariant);
    assert.equal(
      (
        await invoke('drop_personal_skill', alice, {
          skill_id: 'broken-variant-drop-helper',
          variant: 'en',
        })
      ).outcome,
      'success',
    );
    assert.equal(await exists(brokenVariant), false);
    await fs.symlink(linkTarget, deletePersonal);
    assert.equal(
      (
        await invoke('team_mgmt_unlink_skill', manager, {
          member_id: 'alice',
          skill_id: 'delete-helper',
        })
      ).outcome,
      'success',
    );
    await assert.rejects(fs.lstat(deletePersonal), { code: 'ENOENT' });

    const escapingTeam = path.join(linkable, 'escaping-helper');
    await fs.symlink(path.relative(linkable, rtws), escapingTeam);
    assert.equal(
      (
        await invoke('team_mgmt_link_skill', manager, {
          member_id: 'alice',
          skill_id: 'escaping-helper',
        })
      ).outcome,
      'success',
    );
    const escapingPersonal = path.join(personal, 'escaping-helper');
    assert.equal((await fs.lstat(escapingPersonal)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(escapingPersonal), rtws);
    // A deliberately linked directory without a SKILL file is not a package; this is not an outside-path ban.
    assert.equal(
      (await catalog()).some((s) => s.id === 'escaping-helper'),
      false,
    );
    await fs.unlink(escapingPersonal);
    await fs.unlink(escapingTeam);
    const outsideLink = path.join(personal, 'outside-link');
    await fs.symlink(path.relative(personal, rtws), outsideLink);
    assert.equal(
      (await catalog()).some((s) => s.id === 'outside-link'),
      false,
    );
    await fs.unlink(outsideLink);
    const rootLink = path.join(personal, 'root-link');
    await fs.symlink(path.relative(personal, linkable), rootLink);
    assert.equal(
      (await catalog()).some((s) => s.id === 'root-link'),
      false,
    );
    await fs.unlink(rootLink);

    const variantLoadSource = path.join(rtws, 'external-skill-files', 'variant-load-target.md');
    const variantLoad = markdown(
      'variant-load-target',
      'Variant file symlink loads.',
      'Variant symlink body.',
    );
    await seed(variantLoadSource, variantLoad);
    const variantLoadDir = path.join(personal, 'variant-load-helper');
    await fs.mkdir(variantLoadDir, { recursive: true });
    await fs.symlink(
      path.relative(variantLoadDir, variantLoadSource),
      path.join(variantLoadDir, 'SKILL.en.md'),
    );
    await checkSkill(
      'variant-load-helper',
      'variant-load-target',
      'Variant file symlink loads.',
      'Variant symlink body.',
    );
    await guide(
      'variant-link-catalog',
      'variant-load-helper',
      'Variant file symlink loads.',
      'Variant symlink body.',
    );
    async function brokenCatalog(id: string, link: string, target: string) {
      const before = await tree(skillsRoot);
      let failure: unknown;
      try {
        await loadAgentMinds('alice', dialog);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.deepEqual(await tree(skillsRoot), before);
      assert.equal(await fs.readlink(link), target);
      evidence.record({
        id,
        scenario: 'A declared personal skill symlink points to a missing target.',
        businessValue:
          'An agent must see the broken asset and preserve it for repair instead of silently losing the skill.',
        context: { link: path.relative(rtws, link), target, skillTreeUnchanged: true },
        reviewQuestions: [
          'Does the full diagnostic identify the actual broken package or variant path and explain the absent target without misclassifying it?',
        ],
        actualText: failure.message,
      });
    }
    const brokenLoadDir = path.join(personal, 'broken-variant-helper');
    await fs.mkdir(brokenLoadDir, { recursive: true });
    const brokenLoadVariant = path.join(brokenLoadDir, 'SKILL.en.md');
    await fs.symlink('../missing-variant-target.md', brokenLoadVariant);
    await brokenCatalog('broken-variant-load', brokenLoadVariant, '../missing-variant-target.md');
    await fs.rm(brokenLoadDir, { recursive: true });
    const brokenPackage = path.join(personal, 'broken-link');
    await fs.symlink('../missing-linkable-package', brokenPackage);
    await brokenCatalog('broken-package-load', brokenPackage, '../missing-linkable-package');
    await fs.unlink(brokenPackage);
    await catalog();

    await fs.rm(linkable, { recursive: true });
    const externalHelper = markdown(
      'external-helper',
      'External helper should not be linkable.',
      'No external linkable root.',
    );
    await seed(path.join(external, 'external-helper', 'SKILL.en.md'), externalHelper);
    await fs.symlink(path.relative(skillsRoot, external), linkable);
    await fs.symlink(
      path.relative(personal, path.join(linkable, 'external-helper')),
      path.join(personal, 'external-helper'),
    );
    await checkSkill(
      'external-helper',
      'external-helper',
      'External helper should not be linkable.',
      'No external linkable root.',
    );
    await guide(
      'explicit-external-root-catalog',
      'external-helper',
      'External helper should not be linkable.',
      'No external linkable root.',
    );
    assert.equal(
      await fs.readFile(path.join(external, 'external-helper', 'SKILL.en.md'), 'utf8'),
      externalHelper,
    );
    await evidence.write();
    await fs.rm(external, { recursive: true, force: true });
  });
  console.log('Skill handler data, catalog, import and symlink effects: passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
