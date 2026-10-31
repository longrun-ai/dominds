import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { fileAppendTool, readFileTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const prefix = 'team/team_yaml_error/';
const evidence = semanticEvidenceCollector('dominds-file-extension-permissions-');
async function main(): Promise<void> {
  await withTempRtws(async (root) => {
    await writeStandardMinds(root);
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      removeProblemsByPrefix(prefix);
      const config = {
        member_defaults: {
          provider: 'local-mock',
          model: 'default',
          read_dirs: ['**'],
          write_dirs: ['**'],
          read_file_ext_names: ['md'],
          write_file_ext_names: ['md'],
          no_read_file_ext_names: ['secret'],
          no_write_file_ext_names: ['tmp'],
        },
        default_responder: 'alice',
        members: {
          alice: {
            name: 'Alice',
            read_file_ext_names: ['md', 'ts', 'secret'],
            write_file_ext_names: ['md', 'tmp', 'bak'],
            no_write_file_ext_names: ['tmp', 'bak'],
          },
          bob: { name: 'Bob' },
        },
      };
      await fs.writeFile('.minds/team.yaml', YAML.stringify(config));
      const team = await Team.load();
      const alice = team.getMember('alice');
      const bob = team.getMember('bob');
      assert.ok(alice && bob);
      assert.deepEqual(team.memberDefaults.read_file_ext_names, ['md']);
      assert.deepEqual(team.memberDefaults.write_file_ext_names, ['md']);
      assert.deepEqual(team.memberDefaults.no_read_file_ext_names, ['secret']);
      assert.deepEqual(team.memberDefaults.no_write_file_ext_names, ['tmp']);
      assert.deepEqual(alice.read_file_ext_names, ['md', 'ts', 'secret']);
      assert.deepEqual(alice.write_file_ext_names, ['md', 'tmp', 'bak']);
      assert.deepEqual(alice.no_read_file_ext_names, ['secret']);
      assert.deepEqual(alice.no_write_file_ext_names, ['tmp', 'bak']);
      assert.deepEqual(bob.read_file_ext_names, ['md']);
      assert.deepEqual(bob.write_file_ext_names, ['md']);
      assert.deepEqual(bob.no_read_file_ext_names, ['secret']);
      assert.deepEqual(bob.no_write_file_ext_names, ['tmp']);
      assert.equal(
        getProblemsSnapshot().problems.some((p) => p.id.startsWith(prefix)),
        false,
      );
      const dlg = await createMainDialog('alice');
      dlg.setLastUserLanguageCode(language);
      const refusals: Record<string, string> = {};
      const members: readonly Team.Member[] = [alice, bob];
      for (const extension of ['md', 'ts', 'secret', 'tmp', 'bak']) {
        const file = `permission-data-${language}.${extension}`;
        const original = `original-${language}-${extension}\n`;
        await fs.writeFile(file, original);
        for (const member of members) {
          const read = await readFileTool.call(dlg, member, { path: file });
          const canRead: boolean =
            extension === 'md' || (member.id === 'alice' && extension === 'ts');
          assert.equal(read.outcome, canRead ? 'success' : 'failure');
          if (canRead)
            assert.ok(read.content.includes(original.trim()), 'supplied file data is readable');
          else {
            assert.equal(read.content.includes(original.trim()), false);
            refusals[`${member.id}-read-${extension}`] = read.content;
          }
          const write = await fileAppendTool.call(dlg, member, {
            path: file,
            content: `${member.id}-added-data\n`,
          });
          assert.equal(write.outcome, extension === 'md' ? 'success' : 'failure');
          if (extension !== 'md') {
            assert.equal(await fs.readFile(file, 'utf8'), original);
            refusals[`${member.id}-write-${extension}`] = write.content;
          }
        }
        assert.equal(
          await fs.readFile(file, 'utf8'),
          extension === 'md' ? `${original}alice-added-data\nbob-added-data\n` : original,
        );
      }
      await fs.writeFile(
        '.minds/team.yaml',
        YAML.stringify({
          ...config,
          members: { alice: { name: 'Alice', read_file_ext_names: 'md' } },
        }),
      );
      const invalid = await Team.load();
      assert.equal(invalid.getMember('alice'), undefined);
      const problem = getProblemsSnapshot().problems.find((p) => p.id === `${prefix}members/alice`);
      assert.ok(problem);
      assert.equal(problem.kind, 'team_workspace_config_error');
      assert.equal(problem.source, 'team');
      assert.equal(problem.severity, 'error');
      assert.equal(problem.resolved, false);
      await fs.writeFile('.minds/team.yaml', YAML.stringify(config));
      const restored = await Team.load();
      assert.ok(restored.getMember('alice'));
      assert.equal(
        getProblemsSnapshot().problems.some((p) => p.id.startsWith(prefix) && p.resolved !== true),
        false,
      );
      const resolved = getProblemsSnapshot().problems.find((p) => p.id === problem.id);
      assert.ok(resolved);
      assert.equal(resolved.resolved, true);
      evidence.record({
        id: language,
        scenario:
          'Parsed defaults and member overrides control actual file reads/writes; deny lists win even when an extension is allowed. A scalar extension setting removes the invalid member and raises a Problem, then correction resolves the Problem while retaining its history.',
        businessValue:
          'Prevent unintended file access from team configuration while giving the editor a usable diagnosis of invalid permission data.',
        context: {
          language,
          noExternalProviderCalls: true,
          denyOverridesAllowObserved: true,
          refusedWritesPreservedBytes: true,
          problemResolvedWithHistoryAfterCorrection: true,
          scope:
            'Team.load and public tool calls with local mock provider configuration; not driver caller selection or live reload.',
        },
        reviewQuestions: [
          'Do the actual access refusals communicate the denied operation without exposing the supplied file body?',
          'Does the actual configuration Problem explain the invalid extension setting without suggesting that the invalid member remains usable?',
        ],
        actualText: JSON.stringify({ refusals, problem, resolved }, null, 2),
      });
    }
  });
  await evidence.write();
  console.log(
    'team extension defaults, overrides, actual access effects and Problems correction: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
