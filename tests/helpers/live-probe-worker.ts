import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withTempRtws } from '../kernel-driver/helpers';

async function main() {
  const [rawFixture, target, ...args] = process.argv.slice(2);
  assert.ok(rawFixture && target);
  const fixture: unknown = JSON.parse(rawFixture);
  assert.ok(
    fixture &&
      typeof fixture === 'object' &&
      'llmYaml' in fixture &&
      typeof fixture.llmYaml === 'string' &&
      'credential' in fixture &&
      typeof fixture.credential === 'boolean',
  );
  const llmYaml = fixture.llmYaml;
  const script = path.resolve(__dirname, '..', target);
  assert.equal(path.dirname(script), path.resolve(__dirname, '../provider'));
  await withTempRtws(async (rtws) => {
    await fs.mkdir(path.join(rtws, '.minds'), { recursive: true });
    await fs.writeFile(path.join(rtws, '.minds', 'llm.yaml'), llmYaml);
    if (fixture.credential) process.env.DOMINDS_TEST_LIVE_PEER_KEY = 'given-local-probe-key';
    else delete process.env.DOMINDS_TEST_LIVE_PEER_KEY;
    const profile = path.join(rtws, 'owned-probe-profile');
    process.env.DOMINDS_TEST_PROBE_AUTH_DIR = profile;
    if ('readableProfile' in fixture && fixture.readableProfile === true) {
      await fs.mkdir(profile);
      await fs.writeFile(path.join(profile, 'auth.json'), '{"fixture":true}\n');
    }
  });
  process.argv = [process.argv[0]!, script, ...args];
  await import(pathToFileURL(script).href);
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
