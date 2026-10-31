import assert from 'node:assert/strict';
import { Team } from '../../main/team';
import { envGetTool, envSetTool, envUnsetTool } from '../../main/tools/env';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws } from '../kernel-driver/helpers';

// Preserve the regression that a formerly restricted key is handled by the public tools.
// Values here are synthetic and confined to this test process; the inherited value is restored.
const key = 'CHATGPT_WORKSTATION_BEARER_TOKEN';
const evidence = semanticEvidenceCollector('dominds-environment-tools-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const previous = process.env[key];
    const dialog = await createMainDialog('tester');
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    assert.deepEqual(Object.keys(envGetTool.parameters.properties ?? {}), ['key']);
    try {
      process.env[key] = 'old-token-data';
      assert.equal((await envGetTool.call(dialog, caller, { key })).content, 'old-token-data');
      const set = await envSetTool.call(dialog, caller, { key, value: 'new-token-data' });
      assert.equal(set.outcome, 'success');
      assert.equal(process.env[key], 'new-token-data');
      assert.equal((await envGetTool.call(dialog, caller, { key })).content, 'new-token-data');
      const unset = await envUnsetTool.call(dialog, caller, { key });
      assert.equal(unset.outcome, 'success');
      assert.equal(process.env[key], undefined);
      const missing = await envGetTool.call(dialog, caller, { key });
      assert.equal(missing.outcome, 'success');
      const empty = await envSetTool.call(dialog, caller, { key, value: '' });
      assert.equal(empty.outcome, 'success');
      assert.equal(process.env[key], '');
      assert.equal((await envGetTool.call(dialog, caller, { key })).content, '');
      evidence.record({
        id: 'environment-lifecycle',
        scenario:
          'Read a supplied value, replace it, remove it, then set an empty value through the public environment tools.',
        businessValue:
          'An executing agent can deliberately update process configuration and understand the observed change without confusing empty and absent values.',
        context: {
          key,
          previousSyntheticValue: 'old-token-data',
          suppliedNewValue: 'new-token-data',
          unsetState: true,
          emptyState: '',
          scope:
            'Real process.env via public tools and a real dialog; child-process-local, not OS/shell persistence, other processes or automatic MCP reload.',
        },
        reviewQuestions: [
          'Do the actual acknowledgements and missing/empty results faithfully explain the observed mutations without implying a broader persistent change?',
        ],
        actualText: JSON.stringify(
          {
            set: set.content,
            unset: unset.content,
            getMissing: missing.content,
            setEmpty: empty.content,
          },
          null,
          2,
        ),
      });
      const errors: { operation: string; diagnostic: string }[] = [];
      for (const [tool, args] of [
        [envSetTool, { key: 'INVALID-KEY-DATA', value: 'discarded-data' }],
        [envSetTool, { key, value: 123 }],
        [envUnsetTool, { key: ' ' }],
        [envGetTool, { key: '' }],
      ] as const) {
        const before = { ...process.env };
        let caught: unknown;
        try {
          await tool.call(dialog, caller, args);
        } catch (error: unknown) {
          caught = error;
        }
        assert.ok(caught instanceof Error);
        assert.deepEqual(
          { ...process.env },
          before,
          'invalid arguments leave all environment entries unchanged',
        );
        errors.push({ operation: tool.name, diagnostic: caught.message });
      }
      evidence.record({
        id: 'environment-argument-refusals',
        scenario:
          'Reject an invalid variable name, non-string value and blank names without changing process environment.',
        businessValue:
          'Explain invalid local configuration requests while preventing unintended mutation.',
        context: {
          refusedCalls: 4,
          environmentUnchangedAfterEach: true,
          scope:
            'Public tool argument validation in-process. Diagnostic meaning is reviewed independently of exception type and no-state-change assertions.',
        },
        reviewQuestions: [
          'Do the actual diagnostics correctly identify the invalid arguments, without suggesting a mutation succeeded or inventing a restriction on valid keys?',
        ],
        actualText: JSON.stringify(errors, null, 2),
      });
      await evidence.write();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
  console.log('environment tool mutations and refusals: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
