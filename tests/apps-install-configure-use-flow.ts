import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadAppLockFile } from '../main/apps/app-lock-file';
import { loadAppsConfigurationFile } from '../main/apps/configuration-file';
import { loadDomindsAppManifest } from '../main/apps/manifest';
import { Team } from '../main/team';
import {
  readAppResolution,
  writeAppManifest,
  writeAppText,
  writeLocalApp,
} from './helpers/app-fixture';
import { readAppStateFiles } from './helpers/app-state-files';
import { runDomindsCli } from './helpers/cli-process';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-install-members-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    await writeAppManifest(rtws, 'rtws_root');
    const id = '@tests/install-flow-package';
    const root = path.join(rtws, 'dominds-apps', '@tests', 'install-flow-package');
    const base = await writeLocalApp(root, id, {
      defaultPort: 0,
      teammatesYamlRelPath: '.minds/team.yaml',
    });
    const supplied = { ...base, package: { ...base.package, version: '0.1.0' } };
    await writeAppText(path.join(root, 'app-json.json'), JSON.stringify(supplied));
    await writeAppText(
      path.join(root, 'package.json'),
      JSON.stringify({ name: id, version: '0.1.0', bin: 'bin.js' }),
    );
    const members = {
      reviewer: {
        name: 'Reviewer From Component',
        toolsets: ['ws_read'],
        gofor: ['verify imported component behavior'],
      },
      implementer: {
        name: 'Implementer From Component',
        toolsets: ['ws_read', 'ws_mod', 'codex_inspect_and_patch_tools'],
        gofor: ['implement changes using the selected component capabilities'],
      },
    };
    await writeAppText(path.join(root, '.minds', 'team.yaml'), JSON.stringify({ members }));
    const cli = runDomindsCli(['install', id, '--enable'], rtws);
    assert.equal(cli.status, 0);
    const manifest = await loadDomindsAppManifest({
      packageRootAbs: rtws,
      manifestRelPath: '.minds/app.yaml',
    });
    assert.equal(manifest.kind, 'ok');
    assert.equal(manifest.manifest.dependencies?.length, 1);
    assert.equal(manifest.manifest.dependencies?.[0].id, id);
    const configuration = await loadAppsConfigurationFile({ rtwsRootAbs: rtws });
    assert.notEqual(configuration.kind, 'error');
    if (configuration.kind === 'error') throw new Error(configuration.errorText);
    assert.deepEqual(configuration.file.disabledApps ?? [], []);
    const lock = await loadAppLockFile({ rtwsRootAbs: rtws });
    assert.notEqual(lock.kind, 'error');
    if (lock.kind === 'error') throw new Error(lock.errorText);
    assert.deepEqual(lock.file.apps, [{ id, package: { name: id, version: '0.1.0' } }]);
    const resolution = await readAppResolution(rtws);
    assert.equal(resolution.apps.length, 1);
    const entry = resolution.apps[0];
    assert.equal(entry.id, id);
    assert.equal(entry.enabled, true);
    assert.equal(entry.source.kind, 'local');
    assert.equal(
      entry.source.kind === 'local' ? await fs.realpath(entry.source.pathAbs) : null,
      await fs.realpath(root),
    );
    assert.deepEqual(entry.installJson, supplied);
    assert.ok(typeof entry.assignedPort === 'number' && entry.assignedPort > 0);
    await writeAppText(
      path.join(rtws, '.minds', 'team.yaml'),
      JSON.stringify({
        member_defaults: { provider: 'local-mock', model: 'default' },
        default_responder: 'builder',
        members: {
          builder: { name: 'Builder', toolsets: [] },
          reviewer_from_package: { from: id, use: 'reviewer', name: 'Reviewer Override' },
          implementer_from_package: { from: id, use: 'implementer', name: 'Implementer Override' },
        },
      }),
    );
    const before = await readAppStateFiles(rtws);
    const team = await Team.load();
    const actual: unknown[] = [];
    for (const [key, source, name] of [
      ['reviewer_from_package', members.reviewer, 'Reviewer Override'],
      ['implementer_from_package', members.implementer, 'Implementer Override'],
    ] as const) {
      const member = team.getMember(key);
      assert.ok(member);
      assert.equal(member.name, name);
      assert.deepEqual(member.toolsets, source.toolsets);
      assert.deepEqual(member.gofor, source.gofor);
      actual.push({
        id: member.id,
        name: member.name,
        toolsets: member.toolsets,
        gofor: member.gofor,
      });
    }
    assert.deepEqual(await readAppStateFiles(rtws), before);
    evidence.record({
      id: 'install-local-members',
      scenario:
        'A scoped package ID resolves locally, is installed/enabled, and contributes two member templates; root configuration overrides names while retaining supplied toolsets and purposes.',
      businessValue:
        'Preserve runnable package state and member import data without confusing a successful installation with runtime host/tool health.',
      context: {
        appId: id,
        packageVersion: '0.1.0',
        source: 'local',
        importedMembers: 2,
        hostFactoryStarted: false,
        providerCalled: false,
      },
      reviewQuestions: [
        'Does the complete install receipt describe the local source and state mutations consistently with the actual installed/cache data?',
        'Does it distinguish installation/enablement from proven host health and offer usable diagnosis guidance?',
      ],
      actualText: JSON.stringify(
        { stdout: cli.stdout, stderr: cli.stderr, resolution, importedMembers: actual },
        null,
        2,
      ),
    });
  });
  await evidence.write();
  console.log(
    'real local scoped install persists declaration/lock/config/cache and preserves imported member data and overrides: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
