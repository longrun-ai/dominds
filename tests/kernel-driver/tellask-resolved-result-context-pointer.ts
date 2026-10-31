import assert from 'node:assert/strict';

import {
  formatPendingTellaskFuncResultContent,
  formatResolvedTellaskFuncResultContent,
} from '../../main/llm/kernel-driver/tellask-special';
import {
  formatTellaskResultContextAnchor,
  formatTellaskResultContextContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-result-pointers-');
async function main(): Promise<void> {
  const originalLanguage = getWorkLanguage();
  try {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const [name, status, offset] of [
        ['tellask', 'completed', 17],
        ['tellaskBack', 'failed', 4],
        ['askHuman', 'completed', 2],
        ['askHuman', 'pending', null],
      ] as const) {
        const callId = `pointer-${name}-${status}-${language}`;
        const body = `result-body-data-${callId}`;
        const recordedAt = '2026-07-23 01:08:51';
        const anchor = formatTellaskResultContextAnchor({ callId, callName: name, language });
        const content = formatTellaskResultContextContent({
          callId,
          callName: name,
          content: body,
          language,
        });
        assert.equal(
          content,
          `${anchor}\n\n${body}`,
          'the generated machine anchor and exact supplied body survive framing',
        );
        assert.equal(
          formatTellaskResultContextContent({
            callId,
            callName: name,
            content,
            language: language === 'en' ? 'zh' : 'en',
          }),
          content,
          'already anchored persisted content survives another work language without duplication',
        );
        assert.throws(
          () =>
            formatTellaskResultContextContent({
              callId: `${callId}-other`,
              callName: name,
              content,
              language,
            }),
          { name: 'Error' },
        );
        const pointer =
          offset === null
            ? undefined
            : {
                kind: 'later_context_message' as const,
                recordedAt,
                messageOffset: offset,
                contentAnchor: anchor,
              };
        const receipt = pointer
          ? formatResolvedTellaskFuncResultContent({
              name,
              callId,
              status: status === 'failed' ? 'failed' : 'completed',
              resultPointer: pointer,
            })
          : formatResolvedTellaskFuncResultContent({ name, callId, status: 'pending' });
        if (pointer)
          assert.throws(
            () =>
              formatResolvedTellaskFuncResultContent({
                name,
                callId,
                status: status === 'failed' ? 'failed' : 'completed',
                resultPointer: {
                  ...pointer,
                  contentAnchor: formatTellaskResultContextAnchor({
                    callId: 'other-call-data',
                    callName: name,
                    language,
                  }),
                },
              }),
            { name: 'Error' },
          );
        evidence.record({
          id: `${name}-${status}-${language}`,
          scenario:
            offset === null
              ? 'A human question remains unanswered.'
              : 'A resolved tool receipt points forward to a separately rendered result message.',
          businessValue:
            'Let the executing agent locate the actual result and distinguish teammate work from human input without copying results into status receipts.',
          context: {
            language,
            callName: name,
            callId,
            status,
            recordedAt: offset === null ? 'not available yet' : recordedAt,
            expectedMessageBlocksAfterReceipt: offset ?? 'no result yet',
            expectedResultAnchor: anchor,
            scope:
              'Public renderer with supplied relative-position data; this case does not test runtime offset calculation or real message delivery.',
          },
          reviewQuestions: [
            'Does the actual receipt truthfully distinguish pending, completed and failed results, including human answers versus teammate replies?',
            'For a resolved result, can the executor locate its forward position and unique anchor using the supplied identity, time and offset without a misleading search direction?',
            'For an unanswered question, does the guidance avoid inventing an answer or a completed teammate reply?',
          ],
          actualText: JSON.stringify(
            { receipt, separatelyRenderedResult: offset === null ? null : content },
            null,
            2,
          ),
        });
      }
    }
    // These are legacy persisted machine-envelope values consumed by the runtime parser,
    // not an oracle for the meaning of natural-language guidance.
    const legacy = '【Dominds 诉请结果｜callId: legacy-call-data】\n\nlegacy-body-data';
    assert.equal(
      formatTellaskResultContextContent({
        callId: 'legacy-call-data',
        callName: 'tellask',
        content: legacy,
        language: 'en',
      }),
      legacy,
    );
    assert.throws(
      () =>
        formatTellaskResultContextContent({
          callId: 'legacy-call-data',
          callName: 'tellask',
          content: ` ${legacy}`,
          language: 'en',
        }),
      { name: 'Error' },
    );
    for (const callId of [' leading-data', 'trailing-data ', 'line\u2028data', 'line\u2029data']) {
      assert.throws(
        () => formatTellaskResultContextAnchor({ callId, callName: 'tellask', language: 'en' }),
        { name: 'Error' },
      );
      assert.throws(() => formatPendingTellaskFuncResultContent('askHuman', null, callId), {
        name: 'Error',
      });
    }
  } finally {
    setWorkLanguage(originalLanguage);
  }
  await evidence.write();
  console.log('result-anchor data identity, framing and invalid-input contracts: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
