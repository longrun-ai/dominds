import assert from 'node:assert/strict';
import { runDomindsCli } from '../helpers/cli-process';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-cli-manual-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    for (const [id, args, request] of [
      [
        'workspace-index',
        ['man', 'ws_read', '--topic', 'index'],
        'Read the workspace-reading toolset index.',
      ],
      ['team-guide', ['man', 'team_mgmt'], 'Read the dedicated team-management guide.'],
      [
        'help',
        ['man', '--help'],
        'Learn how to select manual topics, including toolset-specific keys.',
      ],
    ] as const) {
      const result = runDomindsCli(args, rtws);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.ok(result.stdout.length > 0, 'the requested manual emits an actual body');
      evidence.record({
        id,
        scenario: request,
        businessValue:
          'A person or agent can request the relevant manual from the actual CLI, including dedicated guides and topic help.',
        context: {
          language: 'en',
          args: JSON.stringify(args),
          exitCode: result.status,
          scope:
            'Real child CLI, built-in manual assets, isolated workspace. Meaning and requested topic selection are subjectively reviewed, not inferred from titles or keywords.',
        },
        reviewQuestions: [
          'Does the actual output answer this manual request and give coherent guidance for the requested toolset or topic selection?',
        ],
        actualText: result.stdout,
      });
    }
    await evidence.write();
  });
  console.log('CLI manual routing and output: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
