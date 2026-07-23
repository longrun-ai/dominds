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

function main(): void {
  const originalLanguage = getWorkLanguage();
  try {
    setWorkLanguage('zh');
    const zh = formatResolvedTellaskFuncResultContent({
      name: 'tellask',
      callId: 'call_pointer_zh',
      status: 'completed',
      resultPointer: {
        kind: 'later_context_message',
        recordedAt: '2026-07-23 01:08:51',
        messageOffset: 17,
        contentAnchor: '【Dominds 诉请结果｜callId: call_pointer_zh】',
      },
    });
    assert.match(zh, /callId: call_pointer_zh/u);
    assert.match(zh, /诉请结果记录时间: 2026-07-23 01:08:51/u);
    assert.match(zh, /向后约第 17 个消息块/u);
    assert.match(zh, /唯一首行锚点: "【Dominds 诉请结果｜callId: call_pointer_zh】"/u);
    assert.match(zh, /锚点已包含同一 callId/u);
    assert.doesNotMatch(zh, /回执之前|向前/u);

    setWorkLanguage('en');
    const en = formatResolvedTellaskFuncResultContent({
      name: 'tellaskBack',
      callId: 'call_pointer_en',
      status: 'failed',
      resultPointer: {
        kind: 'later_context_message',
        recordedAt: '2026-07-23 02:09:14',
        messageOffset: 4,
        contentAnchor: '[Dominds Tellask result | callId: call_pointer_en]',
      },
    });
    assert.match(en, /callId: call_pointer_en/u);
    assert.match(en, /Tellask result recorded at: 2026-07-23 02:09:14/u);
    assert.match(en, /4 message blocks after this tool receipt/u);
    assert.match(
      en,
      /Unique first-line anchor: "\[Dominds Tellask result \| callId: call_pointer_en\]"/u,
    );
    assert.match(en, /Search forward/u);
    assert.doesNotMatch(en, /before this tool receipt/u);

    const anchoredZh = formatTellaskResultContextContent({
      callId: 'call_anchor_zh',
      callName: 'tellask',
      content: '结果正文',
      language: 'zh',
    });
    assert.equal(anchoredZh, '【Dominds 诉请结果｜callId: call_anchor_zh】\n\n结果正文');
    assert.equal(
      formatTellaskResultContextContent({
        callId: 'call_anchor_zh',
        callName: 'tellask',
        content: anchoredZh,
        language: 'en',
      }),
      anchoredZh,
      'an existing canonical anchor must survive a work-language change',
    );
    assert.equal(
      formatTellaskResultContextAnchor({
        callId: 'call_anchor_en',
        callName: 'tellask',
        language: 'en',
      }),
      '[Dominds Tellask result | callId: call_anchor_en]',
    );
    assert.throws(
      () =>
        formatTellaskResultContextContent({
          callId: ' call_with_whitespace',
          callName: 'tellask',
          content: 'result body',
          language: 'en',
        }),
      /must not contain surrounding whitespace/u,
    );
    assert.throws(
      () =>
        formatTellaskResultContextAnchor({
          callId: 'call\u2028line',
          callName: 'tellask',
          language: 'en',
        }),
      /must fit on one line/u,
    );
    assert.throws(
      () =>
        formatTellaskResultContextContent({
          callId: 'call_anchor_zh',
          callName: 'tellask',
          content: ' 【Dominds 诉请结果｜callId: call_anchor_zh】\n\n结果正文',
          language: 'zh',
        }),
      /anchor conflicts/u,
    );
    assert.throws(
      () =>
        formatTellaskResultContextContent({
          callId: 'call_anchor_zh',
          callName: 'tellask',
          content: '【Dominds 诉请结果｜callId: other_call】\n\n结果正文',
          language: 'zh',
        }),
      /anchor conflicts/u,
    );
    assert.throws(
      () =>
        formatResolvedTellaskFuncResultContent({
          name: 'tellask',
          callId: 'call_pointer_zh',
          status: 'completed',
          resultPointer: {
            kind: 'later_context_message',
            recordedAt: '2026-07-23 01:08:51',
            messageOffset: 17,
            contentAnchor: '【Dominds 诉请结果｜callId: wrong_call】',
          },
        }),
      /contentAnchor does not match callId/u,
    );
    const humanResult = formatTellaskResultContextContent({
      callId: 'call_human_answer',
      callName: 'askHuman',
      content: 'Human answer body',
      language: 'en',
    });
    assert.equal(
      humanResult,
      '[Dominds human answer result | callId: call_human_answer]\n\nHuman answer body',
    );
    const humanStatus = formatResolvedTellaskFuncResultContent({
      name: 'askHuman',
      callId: 'call_human_answer',
      status: 'completed',
      resultPointer: {
        kind: 'later_context_message',
        recordedAt: '2026-07-23 03:10:11',
        messageOffset: 2,
        contentAnchor: '[Dominds human answer result | callId: call_human_answer]',
      },
    });
    assert.match(humanStatus, /\[Dominds human answer result status\]/u);
    assert.match(humanStatus, /The human has answered/u);
    assert.match(humanStatus, /2 message blocks after this tool receipt/u);
    assert.doesNotMatch(humanStatus, /Tellask reply/u);
    const pendingHumanStatus = formatResolvedTellaskFuncResultContent({
      name: 'askHuman',
      callId: 'call_human_pending',
      status: 'pending',
    });
    assert.match(pendingHumanStatus, /\[Dominds waiting for human answer\]/u);
    assert.doesNotMatch(pendingHumanStatus, /Tellask reply/u);
    assert.throws(
      () => formatPendingTellaskFuncResultContent('tellask', null, ' call_pending'),
      /invalid callId/u,
    );
    assert.throws(
      () => formatPendingTellaskFuncResultContent('askHuman', null, 'call\u2029pending'),
      /invalid callId/u,
    );

    console.log('kernel-driver tellask-resolved-result-context-pointer: PASS');
  } finally {
    setWorkLanguage(originalLanguage);
  }
}

main();
