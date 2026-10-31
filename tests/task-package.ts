import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../main/tool';
import {
  changeMindTool,
  doMindTool,
  mindMoreTool,
  neverMindTool,
  recallTaskdocTool,
} from '../main/tools/ctrl';
import {
  computeTaskPackageContentHash,
  readTaskPackageSections,
  updateTaskPackageSection,
} from '../main/utils/task-package';
import { formatTaskDocContent } from '../main/utils/taskdoc';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

async function tree(root: string) {
  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { kind: 'missing' };
    throw error;
  }
  if (stat.isFile()) return { kind: 'file', content: await fs.readFile(root, 'utf8') };
  assert.ok(stat.isDirectory());
  const entries = (await fs.readdir(root, { recursive: true })).sort();
  const files: Record<string, string> = {};
  for (const entry of entries) {
    const file = path.join(root, entry);
    if ((await fs.stat(file)).isFile()) files[entry] = await fs.readFile(file, 'utf8');
  }
  return { kind: 'directory', entries, files };
}
// The public recall token is machine data consumed by previous_content_hash,
// not a keyword used to judge the meaning of guidance or user-written body text.
function recallToken(content: string) {
  const fields = [...content.matchAll(/^content_hash: `(crc32:[0-9a-f]{8})`$/gm)];
  assert.equal(fields.length, 1);
  return fields[0]![1]!;
}
async function main() {
  const evidence = semanticEvidenceCollector('dominds-taskdoc-guidance-');
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['sidekick'] });
    const team = await Team.load();
    const caller = team.getMember('tester');
    const sideCaller = team.getMember('sidekick');
    assert.ok(caller && sideCaller);
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const record = (
        id: string,
        scenario: string,
        actualText: string,
        context: Record<string, string | number | boolean>,
      ) =>
        evidence.record({
          id: language + '-' + id,
          scenario,
          businessValue:
            'Agents can safely understand and maintain shared Taskdoc state without losing other contributions or attempting unavailable writes.',
          context: {
            language,
            ...context,
            scope:
              'Native dialog/member/disk and direct Taskdoc APIs; supplied task content is untrusted fixture data. No LLM drive, human exchange, multi-process CAS or crash durability is established.',
          },
          reviewQuestions: [
            'Given the actual caller role, supplied inputs and observed state, is the complete guidance accurate, consistent and actionable without invented permissions or unsafe overwrite advice?',
          ],
          actualText,
        });
      const render = async (dialog: Dialog, id: string, scenario: string) => {
        const root = path.resolve(rtws, dialog.taskDocPath);
        const before = await tree(root);
        const result = await formatTaskDocContent(dialog);
        assert.equal(result.type, 'environment_msg');
        if (result.type !== 'environment_msg') throw new Error('Unexpected Taskdoc envelope');
        assert.equal(result.role, 'user');
        assert.equal(typeof result.content, 'string');
        assert.deepEqual(await tree(root), before);
        record(id, scenario, result.content, {
          taskDocPath: dialog.taskDocPath,
          actorId: dialog.agentId,
          role: dialog.askerDialog === undefined ? 'Main' : 'Side',
          onDisk: JSON.stringify(before),
          packageUnchanged: true,
        });
        return result.content;
      };
      const taskDocPath = 'taskdoc-data-' + language + '.tsk';
      const directory = path.join(rtws, taskDocPath);
      const dialog = await createMainDialog('tester', taskDocPath);
      dialog.setLastUserLanguageCode(language);
      const legacyPath = 'taskdoc-legacy-' + language + '.md';
      const legacyData = 'legacy-file-body-data:75c1';
      await fs.writeFile(legacyPath, legacyData, { flag: 'wx' });
      const legacy = await createMainDialog('tester', legacyPath);
      const legacyText = await render(
        legacy,
        'legacy-path',
        'An owned legacy .md file is not a valid directory-based Taskdoc. Formatting must not mutate or inject its given body.',
      );
      assert.ok(!legacyText.includes(legacyData));
      const external = rtws + '-sibling-' + language + '.tsk';
      await fs.mkdir(external); // Exclusive creation; never replace an unowned sibling.
      console.log('Owned prefix-sibling Taskdoc fixture: ' + external);
      const externalData = 'outside-taskdoc-body-data:314b\n';
      await fs.writeFile(path.join(external, 'goals.md'), externalData);
      const externalBefore = await tree(external);
      const externalDialog = await createMainDialog('tester', path.relative(rtws, external));
      const externalText = await render(
        externalDialog,
        'outside-format',
        'An existing prefix-sibling Taskdoc lies outside rtws; formatting does not inject its supplied body or change it.',
      );
      assert.ok(!externalText.includes(externalData.trimEnd()));
      const externalAppend = await mindMoreTool.call(externalDialog, caller, {
        items: ['outside-mutation-data:bd19'],
      });
      assert.equal(externalAppend.outcome, 'failure');
      assert.deepEqual(await tree(external), externalBefore);
      record(
        'outside-append',
        'A valid Main append request targets an existing owned Taskdoc outside rtws and is refused without changing it.',
        externalAppend.content,
        {
          taskDocPath: externalDialog.taskDocPath,
          existingOutsideData: externalData,
          unchanged: true,
        },
      );
      await render(
        dialog,
        'missing-main',
        'A Main Taskdoc has no resident files yet; its guidance must identify the explicit creation path without creating files itself.',
      );
      assert.deepEqual(await tree(directory), { kind: 'missing' });
      const makeSide = (root: typeof dialog, callId: string) =>
        root.createSideDialog(
          'sidekick',
          ['@sidekick'],
          'given-taskdoc-assignment-data:' + callId,
          {
            callName: 'tellask',
            originMemberId: root.agentId,
            askerDialogId: root.id.selfId,
            callId,
            callSiteCourse: toCallSiteCourseNo(root.currentCourse),
            callSiteGenseq: toCallSiteGenseqNo(1),
          },
        );
      const side = await makeSide(dialog, 'taskdoc-format-' + language);
      await render(
        side,
        'missing-side',
        'The real Side Dialog sees a package with missing resident files. All creation/maintenance advice must respect that its four Taskdoc write tools are unavailable.',
      );
      const goals = '- Ship v1 [goals-data:62a1]\n- Zero regressions';
      const constraints = '- No web browsing [constraints-data:c8f1]\n- Keep diffs minimal';
      const progress = '- Updated Taskdoc selector vocabulary [progress-data:73b9]';
      for (const [section, content] of [
        ['goals', goals],
        ['constraints', constraints],
        ['progress', progress],
      ] as const)
        await updateTaskPackageSection({
          taskPackageDirFullPath: directory,
          section,
          content,
          updatedBy: caller.id,
        });
      assert.deepEqual(await readTaskPackageSections(directory), {
        goals: { kind: 'present', content: goals + '\n' },
        constraints: { kind: 'present', content: constraints + '\n' },
        progress: { kind: 'present', content: progress + '\n' },
      });
      const residentText = await render(
        dialog,
        'resident-main',
        'A Main receives three supplied resident sections and maintenance guidance. Their opaque source bodies must survive injection.',
      );
      for (const content of [goals, constraints, progress])
        assert.ok(residentText.includes(content));
      const contractsData = 'given-contracts-body-data:4a7c\n';
      const risksData = 'given-risks-body-data:8b25\n';
      const excludedData = 'excluded-bear-extra-body-data:5f21\n';
      await fs.mkdir(path.join(directory, 'bearinmind'));
      for (const [file, body] of [
        ['contracts.md', contractsData],
        ['risks.md', risksData],
        ['extra.md', excludedData],
      ])
        await fs.writeFile(path.join(directory, 'bearinmind', file!), body!);
      await fs.mkdir(path.join(directory, 'ux'));
      const checklist = 'UX checklist body data:951c\n';
      await fs.writeFile(path.join(directory, 'ux/checklist.md'), checklist);
      const indexedText = await render(
        dialog,
        'indexed-main',
        'The Main sees whitelisted bearinmind bodies in order, an excluded extra entry, and an index of extra sections whose body requires recall.',
      );
      for (const value of [goals, constraints, progress, contractsData, risksData])
        assert.ok(indexedText.includes(value.trimEnd()));
      assert.ok(!indexedText.includes(excludedData.trimEnd()));
      assert.ok(indexedText.includes('ux/checklist.md')); // Supplied path identifier, not index-heading prose.
      assert.ok(!indexedText.includes(checklist.trimEnd()));
      assert.ok(indexedText.indexOf(constraints) < indexedText.indexOf(contractsData.trimEnd()));
      assert.ok(
        indexedText.indexOf(contractsData.trimEnd()) < indexedText.indexOf(risksData.trimEnd()),
      );
      assert.ok(indexedText.indexOf(risksData.trimEnd()) < indexedText.indexOf(progress));
      await render(
        side,
        'indexed-side',
        'A real Side sees existing resident and extra-index data. Shared index/maintenance instructions must consistently route writes to its Main maintainer, while allowing recall.',
      );
      const recall = async (target: Dialog, args: ToolArguments) => {
        const before = await tree(path.resolve(rtws, target.taskDocPath));
        const result = await recallTaskdocTool.call(
          target,
          target === side ? sideCaller : caller,
          args,
        );
        assert.equal(result.outcome, 'success');
        assert.deepEqual(await tree(path.resolve(rtws, target.taskDocPath)), before);
        return { result, token: recallToken(result.content) };
      };
      const extraRecall = await recall(dialog, { category: 'ux', selector: 'checklist' });
      assert.ok(extraRecall.result.content.includes(checklist));
      record(
        'recall-extra',
        'A Main explicitly recalls the indexed extra section with its complete given body and usable version token.',
        extraRecall.result.content,
        {
          args: JSON.stringify({ category: 'ux', selector: 'checklist' }),
          body: checklist,
          token: extraRecall.token,
        },
      );
      const residentRecall = await recall(dialog, { selector: 'progress' });
      assert.ok(residentRecall.result.content.includes(progress));
      record(
        'recall-resident',
        'A resident section can also be explicitly recalled without mutating the package.',
        residentRecall.result.content,
        {
          args: JSON.stringify({ selector: 'progress' }),
          body: progress + '\n',
          token: residentRecall.token,
        },
      );
      const sideRecall = await recall(side, { category: 'ux', selector: 'checklist' });
      assert.ok(sideRecall.result.content.includes(checklist));
      assert.equal(sideRecall.token, extraRecall.token);
      record(
        'recall-side',
        'The same shared extra section remains readable through recall in a Side Dialog despite its write restrictions.',
        sideRecall.result.content,
        {
          actorId: side.agentId,
          maintainerId: caller.id,
          body: checklist,
          token: sideRecall.token,
        },
      );
      const reject = async (id: string, tool: FuncTool, args: ToolArguments, scenario: string) => {
        const before = await tree(directory);
        const result = await tool.call(dialog, caller, args);
        assert.equal(result.outcome, 'failure');
        assert.deepEqual(await tree(directory), before);
        record(id, scenario, result.content, {
          tool: tool.name,
          args: JSON.stringify(args),
          packageUnchanged: true,
          before: JSON.stringify(before),
        });
      };
      await reject(
        'missing-recall',
        recallTaskdocTool,
        { category: 'ux', selector: 'missing' },
        'A missing extra-section recall is refused; creation/append/rewrite advice must fit an actually missing target.',
      );
      const createNotes = await doMindTool.call(dialog, caller, {
        category: 'ux',
        selector: 'notes',
        content: 'UX notes\r\n\r\n',
      });
      assert.equal(createNotes.outcome, 'success');
      assert.equal(await fs.readFile(path.join(directory, 'ux/notes.md'), 'utf8'), 'UX notes\n');
      await reject(
        'duplicate-extra',
        doMindTool,
        { category: 'ux', selector: 'notes', content: 'forbidden overwrite data' },
        'Explicit creation refuses an existing extra section and preserves the original data.',
      );
      await reject(
        'change-missing',
        changeMindTool,
        {
          category: 'ux',
          selector: 'missing',
          content: 'must not create',
          previous_content_hash: 'crc32:e0117757',
        },
        'A validly shaped replacement token cannot turn a missing section into a new file.',
      );
      for (const [id, hash] of [
        ['no-hash', undefined],
        ['invalid-hash', 'not-a-hash'],
        ['legacy-hash', 'sha256:' + '0'.repeat(64)],
        ['stale-hash', 'crc32:e0117757'],
      ] as const) {
        const args: ToolArguments = {
          category: 'ux',
          selector: 'checklist',
          content: 'must not replace this data',
        };
        if (hash !== undefined) args.previous_content_hash = hash;
        await reject(
          id,
          changeMindTool,
          args,
          'An existing section refuses a missing, malformed, retired-format or stale version token; its complete current data remains unchanged.',
        );
      }
      // Independent canonical CRC32 vector: Python zlib.crc32(b'123456789\\n') = e0117757.
      assert.equal(computeTaskPackageContentHash('123456789\r\n\r\n'), 'crc32:e0117757');
      const vectorCreate = await doMindTool.call(dialog, caller, {
        category: 'ux',
        selector: 'hash-vector',
        content: '123456789\r\n',
      });
      assert.equal(vectorCreate.outcome, 'success');
      const vector = await recall(dialog, { category: 'ux', selector: 'hash-vector' });
      assert.equal(vector.token, 'crc32:e0117757');
      const changed = await changeMindTool.call(dialog, caller, {
        category: 'ux',
        selector: 'checklist',
        content: 'UX replaced\r\n\r\n',
        previous_content_hash: extraRecall.token,
      });
      assert.equal(changed.outcome, 'success');
      assert.equal(
        await fs.readFile(path.join(directory, 'ux/checklist.md'), 'utf8'),
        'UX replaced\n',
      );
      const current = await recall(dialog, { category: 'ux', selector: 'checklist' });
      const replacements = [
        'first concurrent replacement data:2c18',
        'second concurrent replacement data:7d39',
      ];
      const outcomes: ToolCallOutput[] = await Promise.all(
        replacements.map((content) =>
          changeMindTool.call(dialog, caller, {
            category: 'ux',
            selector: 'checklist',
            content,
            previous_content_hash: current.token,
          }),
        ),
      );
      assert.equal(outcomes.filter((row) => row.outcome === 'success').length, 1);
      assert.equal(outcomes.filter((row) => row.outcome === 'failure').length, 1);
      const winningIndex = outcomes.findIndex((row) => row.outcome === 'success');
      const winner = replacements[winningIndex]! + '\n';
      assert.equal(await fs.readFile(path.join(directory, 'ux/checklist.md'), 'utf8'), winner);
      const failed = outcomes.find((row) => row.outcome === 'failure')!;
      record(
        'concurrent-version',
        'Two actual concurrent replacements use the same recalled version; one wins and the rejected writer must reread/merge without losing the winning data.',
        failed.content,
        {
          sharedToken: current.token,
          inputs: JSON.stringify(replacements),
          successfulInputIndex: winningIndex,
          finalDisk: winner,
          scopeDetail: 'Real same-process per-file mutex, not cross-process CAS or crash recovery.',
        },
      );
      await reject(
        'delete-invalid-category',
        neverMindTool,
        { category: 123, selector: 'checklist' },
        'An invalid category value is refused without deleting the existing target or any other package file.',
      );
      assert.equal(
        (await neverMindTool.call(dialog, caller, { category: 'ux', selector: 'checklist' }))
          .outcome,
        'success',
      );
      await assert.rejects(fs.stat(path.join(directory, 'ux/checklist.md')), { code: 'ENOENT' });
      await reject(
        'delete-missing',
        neverMindTool,
        { category: 'ux', selector: 'checklist' },
        'Deleting an already missing section is refused and preserves all other Taskdoc files.',
      );
      const append = await mindMoreTool.call(dialog, caller, {
        items: ['- Worker A finished backend wiring', '- Next: verify UI contract'],
      });
      assert.equal(append.outcome, 'success');
      assert.equal(
        await fs.readFile(path.join(directory, 'progress.md'), 'utf8'),
        progress + '\n- Worker A finished backend wiring\n- Next: verify UI contract\n',
      );
      assert.equal(
        (
          await mindMoreTool.call(dialog, caller, {
            selector: 'goals',
            items: ['- Keep Taskdoc updates low-friction'],
            sep: '\n\n',
          })
        ).outcome,
        'success',
      );
      assert.equal(
        await fs.readFile(path.join(directory, 'goals.md'), 'utf8'),
        goals + '\n\n- Keep Taskdoc updates low-friction\n',
      );
      await updateTaskPackageSection({
        taskPackageDirFullPath: directory,
        section: 'constraints',
        content: '- Existing constraint\r\r',
        updatedBy: caller.id,
      });
      assert.equal(
        (
          await mindMoreTool.call(dialog, caller, {
            selector: 'constraints',
            items: ['- Added constraint'],
            sep: '\n\n',
          })
        ).outcome,
        'success',
      );
      assert.equal(
        await fs.readFile(path.join(directory, 'constraints.md'), 'utf8'),
        '- Existing constraint\n\n- Added constraint\n',
      );
      await updateTaskPackageSection({
        taskPackageDirFullPath: directory,
        section: 'constraints',
        content: '',
        updatedBy: caller.id,
      });
      assert.equal(await fs.readFile(path.join(directory, 'constraints.md'), 'utf8'), '');
      assert.equal(
        (await neverMindTool.call(dialog, caller, { selector: 'constraints' })).outcome,
        'success',
      );
      assert.deepEqual((await readTaskPackageSections(directory)).constraints, { kind: 'missing' });
      assert.equal(
        (
          await doMindTool.call(dialog, caller, {
            selector: 'constraints',
            content: '- Recreated constraint\r\n\r\n',
          })
        ).outcome,
        'success',
      );
      assert.equal(
        await fs.readFile(path.join(directory, 'constraints.md'), 'utf8'),
        '- Recreated constraint\n',
      );
      await reject(
        'duplicate-resident',
        doMindTool,
        { selector: 'constraints', content: 'must not overwrite' },
        'A recreated resident section still obeys explicit-create no-overwrite behavior.',
      );

      // Every Side refusal has a valid input with an actual Main success control.
      const guardedPath = 'taskdoc-side-guard-' + language + '.tsk';
      const guardedDirectory = path.join(rtws, guardedPath);
      const guardedMain = await createMainDialog('tester', guardedPath);
      await updateTaskPackageSection({
        taskPackageDirFullPath: guardedDirectory,
        section: 'progress',
        content: 'guard-progress-data:34b1',
        updatedBy: caller.id,
      });
      await updateTaskPackageSection({
        taskPackageDirFullPath: guardedDirectory,
        section: 'constraints',
        content: 'guard-constraints-data:cf73',
        updatedBy: caller.id,
      });
      const guardedSide = await makeSide(guardedMain, 'taskdoc-write-guard-' + language);
      const guardRecall = await recall(guardedMain, { selector: 'progress' });
      const guardCases: Array<{
        tool: FuncTool;
        args: ToolArguments;
        file: string;
        expected: string | null;
      }> = [
        {
          tool: doMindTool,
          args: { category: 'ux', selector: 'created', content: 'guard-created-data:e571' },
          file: 'ux/created.md',
          expected: 'guard-created-data:e571\n',
        },
        {
          tool: changeMindTool,
          args: {
            selector: 'progress',
            content: 'guard-replaced-data:14f1',
            previous_content_hash: guardRecall.token,
          },
          file: 'progress.md',
          expected: 'guard-replaced-data:14f1\n',
        },
        {
          tool: mindMoreTool,
          args: { items: ['guard-appended-data:65b9'] },
          file: 'progress.md',
          expected: 'guard-replaced-data:14f1\nguard-appended-data:65b9\n',
        },
        {
          tool: neverMindTool,
          args: { selector: 'constraints' },
          file: 'constraints.md',
          expected: null,
        },
      ];
      for (const row of guardCases) {
        const before = await tree(guardedDirectory);
        const refusal = await row.tool.call(guardedSide, sideCaller, row.args);
        assert.equal(refusal.outcome, 'failure');
        assert.deepEqual(await tree(guardedDirectory), before);
        const positive = await row.tool.call(guardedMain, caller, row.args);
        assert.equal(positive.outcome, 'success');
        if (row.expected === null)
          await assert.rejects(fs.stat(path.join(guardedDirectory, row.file)), { code: 'ENOENT' });
        else
          assert.equal(
            await fs.readFile(path.join(guardedDirectory, row.file), 'utf8'),
            row.expected,
          );
        record(
          'side-' + row.tool.name,
          'A real Side request with otherwise valid arguments is refused unchanged; the identical Main request actually succeeds with the expected file effect.',
          refusal.content,
          {
            tool: row.tool.name,
            args: JSON.stringify(row.args),
            actorId: sideCaller.id,
            maintainerId: caller.id,
            sideUnchanged: true,
            mainOutcome: positive.outcome,
            mainExpectedEffect: row.expected ?? 'target removed',
          },
        );
      }
      await fs.rm(external, { recursive: true }); // Only after all assertions; failing evidence remains.
    }
  });
  await evidence.write();
  console.log(
    'Native shared Taskdoc files, versioned concurrency, read fidelity and Main/Side boundaries: PASS',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
