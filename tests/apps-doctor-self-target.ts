import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runDoctor } from '../main/cli/doctor';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-doctor-self-target-'));

  try {
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', 'id: chatgpt-workstation', ''].join(
        '\n',
      ),
    );

    const report = await runDoctor({ rtwsRootAbs: tmpRoot, appId: '.' });
    assert.equal(
      report.diagnoses.length,
      1,
      'doctor should report exactly one self-target diagnosis',
    );
    const diagnosis = report.diagnoses[0];
    assert.equal(diagnosis.appId, '.');
    assert.equal(
      diagnosis.declared,
      true,
      'self target should count root manifest presence as declared',
    );
    assert.equal(
      diagnosis.status,
      'healthy',
      'doctor . should be healthy when root app manifest exists and dependencies are intentionally empty',
    );
    assert.deepEqual(
      diagnosis.reasons,
      [],
      'doctor . should not report missing dependency reasons for the current rtws self manifest',
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
