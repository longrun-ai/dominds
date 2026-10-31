import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type PeerCall, withReleaseFixture } from './helpers/packaging/release-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-public-release-');
function diagnostic(
  id: string,
  actualText: string,
  context: Record<string, string | boolean | number>,
) {
  evidence.record({
    id,
    scenario: `The actual public release entry refuses ${id} in an owned Git workspace.`,
    businessValue:
      'Explain the blocked release and the applicable next action without misleading the maintainer into believing an artifact was published.',
    context: {
      ...context,
      scope:
        'Copied unmodified production release/guard scripts with real Git, tar, cache and filesystem; only external npm/pnpm peers are controlled. No registry, browser authentication or real publishing.',
    },
    reviewQuestions: [
      'Does the actual refusal accurately explain this observed cause and provide an applicable next action, with no false successful-release claim?',
    ],
    actualText,
  });
}
const callsTo = (calls: PeerCall[], command: string, action: string) =>
  calls.filter((call) => call.command === command && call.args[0] === action);
async function cacheFiles(directory: string): Promise<Record<string, Buffer>> {
  const entries = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await fs.readFile(path.join(directory, entry))]),
    ),
  );
}
async function main(): Promise<void> {
  await withReleaseFixture(async (fixture) => {
    for (const [id, args] of [
      ['preset-otp', ['--otp', '123456']],
      ['preset-otp-equals', ['--otp=123456']],
      ['auth-override', ['--auth-type', 'legacy']],
      ['auth-override-equals', ['--auth-type=legacy']],
    ] as const) {
      const result = await fixture.invoke({}, [...args]);
      assert.equal(result.status, 1);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(await cacheFiles(fixture.cache), {});
      diagnostic(id, `${result.stdout}${result.stderr}`, {
        argv: JSON.stringify(args),
        externalCommands: 0,
        cacheCreated: false,
      });
    }
    const packageFile = path.join(fixture.workspace, 'package.json');
    const before = await fs.readFile(packageFile);
    await fs.appendFile(packageFile, '\n');
    const dirty = await fixture.invoke({});
    assert.equal(dirty.status, 1);
    assert.deepEqual(dirty.calls, []);
    diagnostic('dirty-worktree', `${dirty.stdout}${dirty.stderr}`, {
      dirtyFile: 'package.json',
      externalCommands: 0,
      gitStatus: fixture.git(['status', '--porcelain=v1']),
    });
    await fs.writeFile(packageFile, before);
    assert.equal(fixture.git(['status', '--porcelain=v1']), '');
    const login = await fixture.invoke({ loggedIn: false });
    assert.equal(login.status, 1);
    assert.deepEqual(
      login.calls.map((call) => [call.command, ...call.args]),
      [['npm', 'whoami', '--registry', 'https://registry.npmjs.org/']],
    );
    assert.equal(login.calls[0]?.npmInjectedConfig, null);
    diagnostic('missing-login', `${login.stdout}${login.stderr}`, {
      loggedIn: false,
      externalCallCount: login.calls.length,
      peerEmittedWarnings: true,
    });
    for (const [index, pkg] of fixture.packages.entries()) {
      for (const [kind, userAgent, managed] of [
        ['npm', 'npm/11.0.0', '1'],
        ['unmanaged-pnpm', 'pnpm/11.17.0', '0'],
      ] as const) {
        const result = await fixture.prepublish(index, userAgent, managed);
        assert.equal(result.status, 1);
        assert.deepEqual(result.calls, []);
        diagnostic(`direct-${kind}-${index}`, `${result.stdout}${result.stderr}`, {
          packageName: pkg.name,
          userAgent,
          managed,
          buildOrPublishInvocations: 0,
        });
      }
      const allowed = await fixture.prepublish(index, 'pnpm/11.17.0', '1');
      assert.equal(allowed.status, 0);
      assert.deepEqual(
        allowed.calls.map((call) => [call.command, ...call.args]),
        [['pnpm', 'run', 'build']],
      );
      assert.equal(allowed.calls[0]?.managed, true);
    }
    const dry = await fixture.invoke(
      { loggedIn: false },
      ['--tag', 'fixture-tag'],
      'release:publish-public:dry-run',
    );
    assert.equal(dry.status, 0);
    assert.equal(callsTo(dry.calls, 'npm', 'whoami').length, 0);
    const dryPublish = callsTo(dry.calls, 'npm', 'publish');
    assert.deepEqual(
      dryPublish.map((call) => call.packageName),
      fixture.packages.map((pkg) => pkg.name),
    );
    for (const call of dryPublish)
      assert.deepEqual(call.args.slice(2), [
        '--access',
        'public',
        '--auth-type',
        'web',
        '--dry-run',
        '--tag',
        'fixture-tag',
      ]);
    assert.equal(Object.keys(await cacheFiles(fixture.cache)).length, 8);
    assert.equal(fixture.git(['status', '--porcelain=v1', '--untracked-files=all']), '');
    await fs.rm(fixture.cache, { recursive: true }); // Start the next interruption scenario with no prepared artifacts.
    const failed = await fixture.invoke({ failPublish: true });
    assert.equal(failed.status, 1);
    assert.equal(callsTo(failed.calls, 'pnpm', 'pack').length, 1);
    assert.equal(callsTo(failed.calls, 'npm', 'publish').length, 1);
    const prepared = await cacheFiles(fixture.cache);
    assert.equal(Object.keys(prepared).length, 2);
    assert.equal(fixture.git(['status', '--porcelain=v1', '--untracked-files=all']), '');
    const retried = await fixture.invoke({ failPublish: true });
    assert.equal(retried.status, 1);
    assert.equal(callsTo(retried.calls, 'pnpm', 'run').length, 0);
    assert.equal(callsTo(retried.calls, 'pnpm', 'pack').length, 0);
    assert.equal(callsTo(retried.calls, 'npm', 'publish').length, 1);
    assert.equal(
      callsTo(retried.calls, 'npm', 'publish')[0]?.archiveSha256,
      callsTo(failed.calls, 'npm', 'publish')[0]?.archiveSha256,
    );
    assert.deepEqual(await cacheFiles(fixture.cache), prepared);
    const oldHead = fixture.git(['rev-parse', 'HEAD']);
    await fs.writeFile(
      path.join(fixture.packages[0]!.root, 'artifact.txt'),
      'changed-after-commit-data',
    );
    const newHead = fixture.commit();
    assert.notEqual(newHead, oldHead);
    const changed = await fixture.invoke({ failPublish: true });
    assert.equal(changed.status, 1);
    assert.equal(callsTo(changed.calls, 'pnpm', 'pack').length, 1);
    const archive = callsTo(changed.calls, 'npm', 'publish')[0]?.args[1];
    assert.ok(archive);
    assert.equal(
      execFileSync('tar', ['-xOf', archive, 'package/dist/index.js'], { encoding: 'utf8' }),
      'changed-after-commit-data',
    );
    assert.equal(JSON.parse(await fs.readFile(`${archive}.json`, 'utf8')).gitHead, newHead);
    const beforeUnconfirmed = await cacheFiles(fixture.cache);
    const unconfirmed = await fixture.invoke({ failVerification: true }, ['--tag', 'fixture-tag']);
    assert.equal(unconfirmed.status, 1);
    assert.equal(callsTo(unconfirmed.calls, 'pnpm', 'pack').length, 0);
    assert.deepEqual(
      callsTo(unconfirmed.calls, 'npm', 'publish').map((call) => call.packageName),
      [fixture.packages[0]!.name],
    );
    assert.equal(unconfirmed.calls.at(-1)?.cacheStillPresent, true);
    assert.deepEqual(await cacheFiles(fixture.cache), beforeUnconfirmed);
    const beforeDrift = await cacheFiles(fixture.cache);
    assert.ok(Object.keys(beforeDrift).length > 0);
    const drift = await fixture.invoke({ publishedDrift: true });
    assert.equal(drift.status, 1);
    assert.equal(callsTo(drift.calls, 'npm', 'publish').length, 0);
    assert.deepEqual(await cacheFiles(fixture.cache), beforeDrift);
    diagnostic('existing-version-drift', `${drift.stdout}${drift.stderr}`, {
      packageName: fixture.packages[0]!.name,
      version: fixture.packages[0]!.version,
      localBody: 'changed-after-commit-data',
      registryBody: 'registry-drift-data',
      thisInvocationPublished: false,
      preparedCachePreserved: true,
    });
    const released = await fixture.invoke({}, ['--tag', 'fixture-tag']);
    assert.equal(released.status, 0);
    const publishes = callsTo(released.calls, 'npm', 'publish');
    assert.deepEqual(
      publishes.map((call) => call.packageName),
      fixture.packages.slice(1).map((pkg) => pkg.name),
    );
    assert.equal(
      callsTo(released.calls, 'pnpm', 'pack').length,
      4,
      'the already-published first artifact is checked, then the remaining packages are prepared',
    );
    for (const publish of publishes) {
      assert.deepEqual(publish.args.slice(2), [
        '--access',
        'public',
        '--auth-type',
        'web',
        '--tag',
        'fixture-tag',
      ]);
      const index = released.calls.indexOf(publish);
      const verified = released.calls[index + 1];
      assert.equal(verified?.command, 'npm');
      assert.equal(verified?.args[0], 'view');
      assert.equal(
        verified?.cacheStillPresent,
        true,
        'cache remains until successful registry verification',
      );
    }
    assert.ok(
      released.calls
        .filter((call) => call.command === 'npm')
        .every((call) => call.npmInjectedConfig === null),
    );
    assert.ok(callsTo(released.calls, 'pnpm', 'run').every((call) => call.managed));
    assert.deepEqual(await cacheFiles(fixture.cache), {});
    const unchanged = await fixture.invoke({});
    assert.equal(unchanged.status, 0);
    assert.equal(callsTo(unchanged.calls, 'npm', 'publish').length, 0);
    assert.equal(callsTo(unchanged.calls, 'npm', 'pack').length, 4);
    assert.equal(callsTo(unchanged.calls, 'pnpm', 'pack').length, 4);
    const behind = await fixture.invoke({ behind: true });
    assert.equal(behind.status, 1);
    assert.equal(callsTo(behind.calls, 'pnpm', 'run').length, 0);
    assert.equal(callsTo(behind.calls, 'npm', 'publish').length, 0);
    diagnostic('version-behind-registry', `${behind.stdout}${behind.stderr}`, {
      packageName: fixture.packages[0]!.name,
      localVersion: fixture.packages[0]!.version,
      highestRegistryVersion: '999.0.0',
      thisInvocationPublished: false,
    });
    assert.equal(fixture.git(['status', '--porcelain=v1', '--untracked-files=all']), '');
    await evidence.write();
  });
  console.log('Release refusals, real cache recovery and ordered controlled publish: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
