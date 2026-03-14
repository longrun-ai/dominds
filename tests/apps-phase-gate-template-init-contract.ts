import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  createPhaseGateFixture,
  extractOutput,
  stripBindingsBlock,
  stripFrontmatter,
} from './helpers/phase-gate-flow-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGateFixture();
  try {
    const packageTemplateFileNames = (await fs.readdir(fixture.packageTemplatesDirAbs))
      .filter((entry) => entry.endsWith('.flow.md'))
      .sort();
    assert.deepEqual(packageTemplateFileNames, [
      'mvp_default.flow.md',
      'web_dev_acceptance.flow.md',
    ]);

    const packageTemplateIds = await Promise.all(
      packageTemplateFileNames.map(async (fileName) => {
        const raw = await fs.readFile(path.join(fixture.packageTemplatesDirAbs, fileName), 'utf-8');
        const match = /^---\n([\s\S]*?)\n---\n/m.exec(raw);
        assert.ok(match, `expected template ${fileName} to start with frontmatter`);
        const frontmatter = match?.[1] ?? '';
        const idMatch = /^id:\s*(.+)$/m.exec(frontmatter);
        assert.ok(idMatch, `expected template ${fileName} frontmatter to declare id`);
        const descriptionMatch = /^description:\s*(.+)$/m.exec(frontmatter);
        assert.ok(
          descriptionMatch,
          `expected template ${fileName} frontmatter to declare description`,
        );
        return idMatch?.[1]?.trim() ?? '';
      }),
    );
    assert.deepEqual(packageTemplateIds, ['mvp_default', 'web_dev_acceptance']);

    extractOutput(
      await fixture.tools.initFlow(
        {
          taskDocPath: fixture.taskDocRel,
          templateId: 'mvp_default',
          overwrite: true,
          resetState: false,
        },
        fixture.toolCtx,
      ),
    );

    const packagedTemplate = await fs.readFile(
      path.join(fixture.packageTemplatesDirAbs, 'mvp_default.flow.md'),
      'utf-8',
    );
    const packagedTemplateBody = stripFrontmatter(packagedTemplate);
    const packagedFlowBody = stripBindingsBlock(packagedTemplateBody);
    const mirroredTemplate = await fs.readFile(
      path.join(fixture.rtwsAppDirAbs, 'templates', 'mvp_default.flow.md'),
      'utf-8',
    );
    const initializedFlowMarkdown = await fs.readFile(
      path.join(fixture.taskDocAbs, 'phasegate', 'flow.md'),
      'utf-8',
    );
    const initializedBindingsMarkdown = await fs.readFile(
      path.join(fixture.taskDocAbs, 'phasegate', 'bindings.md'),
      'utf-8',
    );
    assert.doesNotMatch(initializedFlowMarkdown, /^---$/m);
    assert.match(mirroredTemplate, /```phasegate-bindings/);
    assert.doesNotMatch(initializedFlowMarkdown, /```phasegate-bindings/);
    assert.equal(mirroredTemplate, packagedTemplateBody);
    assert.equal(initializedFlowMarkdown, packagedFlowBody);
    assert.match(initializedBindingsMarkdown, /"roleId": "owner"/);

    const currentFlowOutput = extractOutput(
      await fixture.tools.getFlow({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(currentFlowOutput, /"id": "browser_regression"/);
    assert.match(currentFlowOutput, /"participants": \[/);
  } finally {
    await fixture.cleanup();
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
