import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function expectedMainlineReplacement(originalBytes: number): string {
  return [
    '这次函数返回内容太大，清理头脑之前不会显示给你。',
    '',
    '不要再尝试获取各种大段的输出，都不会显示给你。现在先做两件事：',
    '1. 把下一程对话需要知道的此程细节信息写入差遣牒合适章节。',
    '2. 对于不适合差遣牒章节覆盖、但下一程恢复工作需要的信息写入提醒项。',
    '',
    '然后调用 clear_mind({}) 开启新一程。',
    '',
    `详情：本次返回约 ${new Intl.NumberFormat('zh-CN').format(originalBytes)} 字节。`,
  ].join('\n');
}

function expectedSidelineReplacement(originalBytes: number): string {
  return [
    '这次函数返回内容太大，清理头脑之前不会显示给你。',
    '',
    '不要再尝试获取各种大段的输出，都不会显示给你。现在先做两件事：',
    '1. 把需要回传给主线对话的结论、证据定位和风险整理清楚。',
    '2. 对于下一程恢复工作需要的信息，写入提醒项。',
    '',
    '然后调用 clear_mind({}) 开启新一程，并尽快完成当前支线回复。',
    '',
    `详情：本次返回约 ${new Intl.NumberFormat('zh-CN').format(originalBytes)} 字节。`,
  ].join('\n');
}

function expectedEnglishMainlineReplacement(originalBytes: number): string {
  return [
    'This function returned too much content. It will not be shown to you before you clear your mind.',
    '',
    'Do not try again to fetch any kind of large output; it still will not be shown. Do two things now:',
    '1. Write the details from this course that the next course needs into the appropriate Taskdoc sections.',
    '2. Write information that does not fit a Taskdoc section, but is needed to resume the next course, into reminders.',
    '',
    'Then call clear_mind({}) to start a new course.',
    '',
    `Detail: this return was about ${new Intl.NumberFormat('en-US').format(originalBytes)} bytes.`,
  ].join('\n');
}

const PREVIOUS_CAUTION_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 210_000,
  completionTokens: 100,
  totalTokens: 210_100,
  modelContextLimitTokens: 272_000,
  effectiveOptimalMaxTokens: 200_000,
  effectiveCriticalMaxTokens: 244_800,
  hardUtil: 210_000 / 272_000,
  optimalUtil: 210_000 / 200_000,
  level: 'caution',
};
const CONTENT_ITEMS_TOOL_NAME = 'large_tool_output_content_items_probe';
const IMAGE_CONTENT_ITEM_TOOL_NAME = 'large_tool_output_image_content_item_probe';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('zh');
    const contentItemsValue = `content-items-start-${'i'.repeat(2_300)}-content-items-end`;
    const contentItemsTool: FuncTool = {
      type: 'func',
      name: CONTENT_ITEMS_TOOL_NAME,
      description: 'Test-only function tool that returns large model-visible content items.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      followupMode: 'deferred',
      argsValidation: 'passthrough',
      async call() {
        return toolSuccess('short top-level content', [
          { type: 'input_text', text: contentItemsValue },
        ]);
      },
    };
    const imageContentItemByteLength = 2_300;
    const imageContentItemsTool: FuncTool = {
      type: 'func',
      name: IMAGE_CONTENT_ITEM_TOOL_NAME,
      description: 'Test-only function tool that returns a large image content item.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      followupMode: 'deferred',
      argsValidation: 'passthrough',
      async call(dlg) {
        return toolSuccess('short image top-level content', [
          {
            type: 'input_image',
            mimeType: 'image/png',
            byteLength: imageContentItemByteLength,
            artifact: {
              rootId: dlg.id.rootId,
              selfId: dlg.id.selfId,
              status: dlg.status,
              relPath: 'tool-results/test-image.png',
            },
          },
        ]);
      },
    };

    registerTool(contentItemsTool);
    registerTool(imageContentItemsTool);
    await writeStandardMinds(tmpRoot, {
      memberTools: ['env_get', CONTENT_ITEMS_TOOL_NAME, IMAGE_CONTENT_ITEM_TOOL_NAME],
    });
    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  local-mock:',
        '    name: Local Mock',
        '    apiType: mock',
        '    baseUrl: mock-db',
        '    apiKeyEnvVar: MOCK_API_KEY',
        '    models:',
        '      default:',
        '        name: Default',
        '        context_length: 272000',
        '        optimal_max_tokens: 200000',
        '        critical_max_tokens: 244800',
        '',
      ].join('\n'),
      'utf-8',
    );

    const trigger = 'Call env_get while context is already tight.';
    const previousCautionTrigger =
      'Call env_get while previous context health is tight and current usage is unavailable.';
    const recoveredTrigger =
      'Call env_get after previous context health was tight but current usage recovered.';
    const sideTrigger = 'Call env_get in a side dialog while context is already tight.';
    const contentItemsTrigger = 'Call the content-items probe while context is already tight.';
    const imageContentItemTrigger =
      'Call the image content-item probe while context is already tight.';
    const englishTrigger = 'Call env_get in English while context is already tight.';
    const largeValue = `large-start-${'x'.repeat(2_300)}-large-end`;
    const previousCautionLargeValue = `previous-caution-start-${'y'.repeat(2_300)}-previous-caution-end`;
    const recoveredLargeValue = `recovered-start-${'z'.repeat(2_300)}-recovered-end`;
    const sideLargeValue = `side-start-${'s'.repeat(2_300)}-side-end`;
    const englishLargeValue = `english-start-${'e'.repeat(2_300)}-english-end`;
    const envKey = 'DOMINDS_TEST_LARGE_TOOL_OUTPUT';
    const previousCautionEnvKey = 'DOMINDS_TEST_PREVIOUS_CAUTION_LARGE_TOOL_OUTPUT';
    const recoveredEnvKey = 'DOMINDS_TEST_RECOVERED_LARGE_TOOL_OUTPUT';
    const sideEnvKey = 'DOMINDS_TEST_SIDE_LARGE_TOOL_OUTPUT';
    const englishEnvKey = 'DOMINDS_TEST_ENGLISH_LARGE_TOOL_OUTPUT';
    const expectedReplacement = expectedMainlineReplacement(byteLength(largeValue));
    const expectedPreviousCautionReplacement = expectedMainlineReplacement(
      byteLength(previousCautionLargeValue),
    );
    const expectedSideReplacement = expectedSidelineReplacement(byteLength(sideLargeValue));
    const expectedContentItemsReplacement = expectedMainlineReplacement(
      byteLength('short top-level content') + byteLength(contentItemsValue),
    );
    const expectedImageContentItemReplacement = expectedMainlineReplacement(
      byteLength('short image top-level content') + imageContentItemByteLength,
    );
    const expectedEnglishReplacement = expectedEnglishMainlineReplacement(
      byteLength(englishLargeValue),
    );
    process.env[envKey] = largeValue;
    process.env[previousCautionEnvKey] = previousCautionLargeValue;
    process.env[recoveredEnvKey] = recoveredLargeValue;
    process.env[sideEnvKey] = sideLargeValue;
    process.env[englishEnvKey] = englishLargeValue;

    try {
      await writeMockDb(tmpRoot, [
        {
          message: trigger,
          role: 'user',
          response: '我会读取环境变量。',
          funcCalls: [
            {
              id: 'large-env-get',
              name: 'env_get',
              arguments: { key: envKey },
            },
          ],
          usage: { promptTokens: 210_000, completionTokens: 100 },
        },
        {
          message: expectedReplacement,
          role: 'tool',
          response: '我会保存接续信息并清理头脑。',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
        {
          message: previousCautionTrigger,
          role: 'user',
          response: '我会读取另一个环境变量。',
          funcCalls: [
            {
              id: 'previous-caution-large-env-get',
              name: 'env_get',
              arguments: { key: previousCautionEnvKey },
            },
          ],
          usageUnavailable: true,
        },
        {
          message: expectedPreviousCautionReplacement,
          role: 'tool',
          response: '我会按上一轮吃紧状态保存接续信息并清理头脑。',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
        {
          message: recoveredTrigger,
          role: 'user',
          response: '我会在当前健康上下文里读取环境变量。',
          funcCalls: [
            {
              id: 'recovered-large-env-get',
              name: 'env_get',
              arguments: { key: recoveredEnvKey },
            },
          ],
          usage: { promptTokens: 1_000, completionTokens: 100 },
        },
        {
          message: recoveredLargeValue,
          role: 'tool',
          response: '当前上下文已恢复健康，所以我看到了原始输出。',
          usage: { promptTokens: 1_100, completionTokens: 100 },
        },
        {
          message: sideTrigger,
          role: 'user',
          response: '我会在支线对话读取环境变量。',
          funcCalls: [
            {
              id: 'side-large-env-get',
              name: 'env_get',
              arguments: { key: sideEnvKey },
            },
          ],
          usage: { promptTokens: 210_000, completionTokens: 100 },
        },
        {
          message: expectedSideReplacement,
          role: 'tool',
          response: '我会整理回传结论并完成支线回复。',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
        {
          message: contentItemsTrigger,
          role: 'user',
          response: '我会读取一个 contentItems 大返回。',
          funcCalls: [
            {
              id: 'large-content-items-probe',
              name: CONTENT_ITEMS_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { promptTokens: 210_000, completionTokens: 100 },
        },
        {
          message: expectedContentItemsReplacement,
          role: 'tool',
          response: '我会按大返回规则处理 contentItems。',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
        {
          message: imageContentItemTrigger,
          role: 'user',
          response: '我会读取一个图片 contentItem 大返回。',
          funcCalls: [
            {
              id: 'large-image-content-item-probe',
              name: IMAGE_CONTENT_ITEM_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { promptTokens: 210_000, completionTokens: 100 },
        },
        {
          message: expectedImageContentItemReplacement,
          role: 'tool',
          response: '我会按大返回规则处理图片 contentItem。',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
        {
          message: englishTrigger,
          role: 'user',
          response: 'I will read the environment variable.',
          funcCalls: [
            {
              id: 'english-large-env-get',
              name: 'env_get',
              arguments: { key: englishEnvKey },
            },
          ],
          usage: { promptTokens: 210_000, completionTokens: 100 },
        },
        {
          message: expectedEnglishReplacement,
          role: 'tool',
          response: 'I will save the handoff details and clear my mind.',
          usage: { promptTokens: 210_100, completionTokens: 100 },
        },
      ]);

      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;

      await driveDialogStream(
        dlg,
        makeUserPrompt(trigger, 'kernel-driver-context-health-large-tool-output-hidden'),
        true,
      );

      const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
      assert.equal(funcResults.length, 1, 'expected exactly one function result');
      const resultContent = funcResults[0]?.content ?? '';
      assert.equal(resultContent, expectedReplacement);
      assert.match(resultContent, /这次函数返回内容太大，清理头脑之前不会显示给你/);
      assert.match(resultContent, /不要再尝试获取各种大段的输出，都不会显示给你/);
      assert.match(resultContent, /然后调用 clear_mind\(\{\}\) 开启新一程/);
      assert.match(
        resultContent,
        new RegExp(
          `详情：本次返回约 ${new Intl.NumberFormat('zh-CN').format(byteLength(largeValue))} 字节。`,
        ),
      );
      assert.doesNotMatch(resultContent, /large-start/);
      assert.doesNotMatch(resultContent, /large-end/);

      const assistantSayings = dlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        assistantSayings.some((msg) => msg.content === '我会保存接续信息并清理头脑。'),
        true,
        'expected large-output replacement to preserve ordinary immediate model follow-up',
      );

      const previousCautionDlg = await createMainDialog('tester');
      previousCautionDlg.disableDiligencePush = true;
      previousCautionDlg.setLastContextHealth(PREVIOUS_CAUTION_SNAPSHOT);

      await driveDialogStream(
        previousCautionDlg,
        makeUserPrompt(
          previousCautionTrigger,
          'kernel-driver-context-health-previous-caution-large-tool-output-hidden',
        ),
        true,
      );

      const previousCautionFuncResults = previousCautionDlg.msgs.filter(
        (msg) => msg.type === 'func_result_msg',
      );
      assert.equal(
        previousCautionFuncResults.length,
        1,
        'expected exactly one function result for previous-caution scenario',
      );
      const previousCautionResultContent = previousCautionFuncResults[0]?.content ?? '';
      assert.equal(previousCautionResultContent, expectedPreviousCautionReplacement);
      assert.doesNotMatch(previousCautionResultContent, /previous-caution-start/);
      assert.doesNotMatch(previousCautionResultContent, /previous-caution-end/);

      const previousCautionAssistantSayings = previousCautionDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        previousCautionAssistantSayings.some(
          (msg) => msg.content === '我会按上一轮吃紧状态保存接续信息并清理头脑。',
        ),
        true,
        'expected previous context-health snapshot to hide large output when current usage is unavailable',
      );

      const recoveredDlg = await createMainDialog('tester');
      recoveredDlg.disableDiligencePush = true;
      recoveredDlg.setLastContextHealth(PREVIOUS_CAUTION_SNAPSHOT);

      await driveDialogStream(
        recoveredDlg,
        makeUserPrompt(
          recoveredTrigger,
          'kernel-driver-context-health-recovered-large-tool-output-visible',
        ),
        true,
      );

      const recoveredFuncResults = recoveredDlg.msgs.filter(
        (msg) => msg.type === 'func_result_msg',
      );
      assert.equal(
        recoveredFuncResults.length,
        1,
        'expected exactly one function result for recovered context scenario',
      );
      assert.equal(
        recoveredFuncResults[0]?.content,
        recoveredLargeValue,
        'current healthy usage must make large output visible even when previous snapshot was caution',
      );

      const recoveredAssistantSayings = recoveredDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        recoveredAssistantSayings.some(
          (msg) => msg.content === '当前上下文已恢复健康，所以我看到了原始输出。',
        ),
        true,
        'expected healthy current usage to preserve ordinary immediate follow-up from raw tool output',
      );

      const rootForSideDialog = await createMainDialog('tester');
      rootForSideDialog.disableDiligencePush = true;
      const sideDialog = await rootForSideDialog.createSideDialog(
        'tester',
        ['@tester'],
        'Inspect side dialog large output handling.',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: rootForSideDialog.id.selfId,
          callId: 'root-to-side-large-output',
          callSiteCourse: 1,
          callSiteGenseq: 1,
          collectiveTargets: ['tester'],
        },
      );
      sideDialog.disableDiligencePush = true;

      await driveDialogStream(
        sideDialog,
        makeUserPrompt(sideTrigger, 'kernel-driver-context-health-side-large-tool-output-hidden'),
        true,
      );

      const sideFuncResults = sideDialog.msgs.filter((msg) => msg.type === 'func_result_msg');
      assert.equal(sideFuncResults.length, 1, 'expected exactly one side dialog function result');
      const sideResultContent = sideFuncResults[0]?.content ?? '';
      assert.equal(sideResultContent, expectedSideReplacement);
      assert.match(sideResultContent, /把需要回传给主线对话的结论、证据定位和风险整理清楚/);
      assert.match(sideResultContent, /然后调用 clear_mind\(\{\}\) 开启新一程/);
      assert.doesNotMatch(sideResultContent, /如果/);
      assert.doesNotMatch(sideResultContent, /写入差遣牒合适章节/);
      assert.doesNotMatch(sideResultContent, /side-start/);
      assert.doesNotMatch(sideResultContent, /side-end/);

      const sideAssistantSayings = sideDialog.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        sideAssistantSayings.some((msg) => msg.content === '我会整理回传结论并完成支线回复。'),
        true,
        'expected side dialog replacement to trigger immediate model follow-up',
      );

      const contentItemsDlg = await createMainDialog('tester');
      contentItemsDlg.disableDiligencePush = true;

      await driveDialogStream(
        contentItemsDlg,
        makeUserPrompt(
          contentItemsTrigger,
          'kernel-driver-context-health-large-content-items-output-hidden',
        ),
        true,
      );

      const contentItemsFuncResults = contentItemsDlg.msgs.filter(
        (msg) => msg.type === 'func_result_msg',
      );
      assert.equal(
        contentItemsFuncResults.length,
        1,
        'expected exactly one function result for contentItems scenario',
      );
      const contentItemsResult = contentItemsFuncResults[0];
      assert.equal(contentItemsResult?.content, expectedContentItemsReplacement);
      assert.equal(
        contentItemsResult?.contentItems,
        undefined,
        'replacement must remove original contentItems from model-visible result',
      );
      assert.doesNotMatch(contentItemsResult?.content ?? '', /content-items-start/);
      assert.doesNotMatch(contentItemsResult?.content ?? '', /content-items-end/);

      const contentItemsAssistantSayings = contentItemsDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        contentItemsAssistantSayings.some(
          (msg) => msg.content === '我会按大返回规则处理 contentItems。',
        ),
        true,
        'large contentItems replacement must trigger immediate remediation follow-up even when the underlying successful tool is deferred',
      );

      const imageContentItemDlg = await createMainDialog('tester');
      imageContentItemDlg.disableDiligencePush = true;

      await driveDialogStream(
        imageContentItemDlg,
        makeUserPrompt(
          imageContentItemTrigger,
          'kernel-driver-context-health-large-image-content-item-output-hidden',
        ),
        true,
      );

      const imageContentItemFuncResults = imageContentItemDlg.msgs.filter(
        (msg) => msg.type === 'func_result_msg',
      );
      assert.equal(
        imageContentItemFuncResults.length,
        1,
        'expected exactly one function result for image contentItem scenario',
      );
      const imageContentItemResult = imageContentItemFuncResults[0];
      assert.equal(imageContentItemResult?.content, expectedImageContentItemReplacement);
      assert.equal(
        imageContentItemResult?.contentItems,
        undefined,
        'image replacement must remove original contentItems from model-visible result',
      );

      const imageContentItemAssistantSayings = imageContentItemDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        imageContentItemAssistantSayings.some(
          (msg) => msg.content === '我会按大返回规则处理图片 contentItem。',
        ),
        true,
        'large image contentItem replacement must trigger immediate remediation follow-up',
      );

      setWorkLanguage('en');
      const englishDlg = await createMainDialog('tester');
      englishDlg.disableDiligencePush = true;

      await driveDialogStream(
        englishDlg,
        makeUserPrompt(englishTrigger, 'kernel-driver-context-health-english-large-output-hidden'),
        true,
      );

      const englishFuncResults = englishDlg.msgs.filter((msg) => msg.type === 'func_result_msg');
      assert.equal(englishFuncResults.length, 1, 'expected exactly one English function result');
      const englishResultContent = englishFuncResults[0]?.content ?? '';
      assert.equal(englishResultContent, expectedEnglishReplacement);
      assert.match(englishResultContent, /will not be shown to you before you clear your mind/);
      assert.match(englishResultContent, /Do not try again to fetch any kind of large output/);
      assert.match(englishResultContent, /details from this course that the next course needs/);
      assert.match(englishResultContent, /does not fit a Taskdoc section/);
      assert.doesNotMatch(englishResultContent, /english-start/);
      assert.doesNotMatch(englishResultContent, /english-end/);

      const englishAssistantSayings = englishDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.equal(
        englishAssistantSayings.some(
          (msg) => msg.content === 'I will save the handoff details and clear my mind.',
        ),
        true,
        'English large-output replacement must trigger immediate model follow-up',
      );
    } finally {
      setWorkLanguage('zh');
      unregisterTool(CONTENT_ITEMS_TOOL_NAME);
      unregisterTool(IMAGE_CONTENT_ITEM_TOOL_NAME);
      delete process.env[envKey];
      delete process.env[previousCautionEnvKey];
      delete process.env[recoveredEnvKey];
      delete process.env[sideEnvKey];
      delete process.env[englishEnvKey];
    }
  });

  console.log('kernel-driver context-health-large-tool-output-hidden: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver context-health-large-tool-output-hidden: FAIL\n${message}`);
  process.exit(1);
});
