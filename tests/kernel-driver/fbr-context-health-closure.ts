import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SideDialog } from '../../main/dialog';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  buildFbrContextCautionFinalizationPrompt,
  buildProgrammaticFbrContextCriticalContent,
  FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
} from '../../main/llm/kernel-driver/fbr';
import { appendDistinctPerspectiveFbrBody } from '../../main/runtime/fbr-body';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  lastAssistantSaying,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function buildRoundBody(body: string, iteration: number, total: number): string {
  return appendDistinctPerspectiveFbrBody({
    body,
    iteration,
    total,
    language: getWorkLanguage(),
    isFinalRound: iteration === total,
  });
}

async function writeFbrTeamYaml(tmpRoot: string, effort: number): Promise<void> {
  await fs.writeFile(
    path.join(tmpRoot, '.minds', 'team.yaml'),
    [
      'member_defaults:',
      '  provider: local-mock',
      '  model: default',
      `  fbr-effort: ${effort}`,
      'default_responder: tester',
      'members:',
      '  tester:',
      '    name: Tester',
      '    provider: local-mock',
      '    model: default',
      `    fbr-effort: ${effort}`,
      '    diligence-push-max: 2',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeContextHealthLlmYaml(tmpRoot: string): Promise<void> {
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
      '        context_length: 1000',
      '        optimal_max_tokens: 500',
      '        critical_max_tokens: 900',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('zh');
    await writeStandardMinds(tmpRoot);
    await writeFbrTeamYaml(tmpRoot, 3);
    await writeContextHealthLlmYaml(tmpRoot);

    const language = getWorkLanguage();
    const cautionTrigger = '发起一次上下文吃紧后持续要求结论函数的 FBR。';
    const cautionBody = [
      'Goal: 判断当前异常是否已经能收口。',
      'Facts:',
      '- 线索 A 与线索 C 互相支持。',
      '- 线索 B 缺少独立支撑。',
      'Constraint:',
      '- 只能基于正文推理。',
    ].join('\n');
    const cautionFinalContent = [
      '低噪结论：线索 A 与 C 构成稳定共识，线索 B 应视为噪音。',
      '关键未知项：还缺直接复现证据。',
      '下一步：先补复现证据，再决定是否扩大排查。',
    ].join('\n');
    const cautionMirroredResponse = formatTellaskResponseContent({
      callName: 'freshBootsReasoning',
      callId: 'fbr-context-caution-call',
      responderId: 'tester',
      tellaskerId: 'tester',
      tellaskContent: cautionBody,
      responseBody: cautionFinalContent,
      status: 'completed',
      language,
    });
    const cautionRootFinalAnswer = '主线已收到吃紧 FBR 的模型结论。';

    const criticalTrigger = '发起一次上下文告急后硬编码过于复杂结论的 FBR。';
    const criticalBody = [
      'Goal: 判断这个巨大问题是否已经能整体收口。',
      'Facts:',
      '- 分支很多。',
      '- 证据密度不足。',
      'Constraint:',
      '- 只能基于正文推理。',
    ].join('\n');
    const criticalFinalContent = buildProgrammaticFbrContextCriticalContent({ language });
    const criticalMirroredResponse = formatTellaskResponseContent({
      callName: 'freshBootsReasoning',
      callId: 'fbr-context-critical-call',
      responderId: 'tester',
      tellaskerId: 'tester',
      tellaskContent: criticalBody,
      responseBody: criticalFinalContent,
      status: 'completed',
      language,
    });
    const criticalRootFinalAnswer = '主线已收到告急 FBR 的固定过于复杂结论。';

    const cautionDivergence1 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(cautionBody, 1, 3),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 1, total: 3 },
    });
    const criticalDivergence1 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(criticalBody, 1, 3),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 1, total: 3 },
    });
    const cautionFinalization1 = buildFbrContextCautionFinalizationPrompt({
      attempt: 1,
      language,
    });
    const cautionFinalization2 = buildFbrContextCautionFinalizationPrompt({
      attempt: 2,
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: cautionTrigger,
        role: 'user',
        response: '开始吃紧 FBR。',
        usage: { promptTokens: 100, completionTokens: 10 },
        funcCalls: [
          {
            id: 'fbr-context-caution-call',
            name: 'freshBootsReasoning',
            arguments: { tellaskContent: cautionBody, effort: 3 },
          },
        ],
      },
      {
        message: cautionDivergence1,
        role: 'user',
        response: '第一轮后上下文进入吃紧。',
        usage: { promptTokens: 600, completionTokens: 10 },
      },
      {
        message: cautionFinalization1,
        role: 'user',
        response: '我还没有按要求调用结论函数。',
        usage: { promptTokens: 610, completionTokens: 10 },
      },
      {
        message: cautionFinalization2,
        role: 'user',
        response: '',
        usage: { promptTokens: 620, completionTokens: 10 },
        funcCalls: [
          {
            id: 'fbr-context-caution-finalizer',
            name: FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
            arguments: { content: cautionFinalContent },
          },
        ],
      },
      {
        message: cautionMirroredResponse,
        role: 'tool',
        response: cautionRootFinalAnswer,
        usage: { promptTokens: 120, completionTokens: 10 },
      },
      {
        message: criticalTrigger,
        role: 'user',
        response: '开始告急 FBR。',
        usage: { promptTokens: 100, completionTokens: 10 },
        funcCalls: [
          {
            id: 'fbr-context-critical-call',
            name: 'freshBootsReasoning',
            arguments: { tellaskContent: criticalBody, effort: 3 },
          },
        ],
      },
      {
        message: criticalDivergence1,
        role: 'user',
        response: '第一轮后上下文直接告急。',
        usage: { promptTokens: 950, completionTokens: 10 },
      },
      {
        message: criticalMirroredResponse,
        role: 'tool',
        response: criticalRootFinalAnswer,
        usage: { promptTokens: 120, completionTokens: 10 },
      },
    ]);

    const cautionRoot = await createMainDialog('tester');
    cautionRoot.disableDiligencePush = true;
    await driveDialogStream(
      cautionRoot,
      makeUserPrompt(cautionTrigger, 'kernel-driver-fbr-context-health-caution'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(cautionRoot) === cautionRootFinalAnswer,
      8_000,
      'FBR caution context final answer',
    );
    await waitForAllDialogsUnlocked(cautionRoot, 8_000);

    const cautionSideDialog = cautionRoot
      .getLoadedDialogTreeSnapshot()
      .find((dialog): dialog is SideDialog => dialog instanceof SideDialog);
    assert.ok(cautionSideDialog, 'expected caution FBR side dialog');
    const cautionPromptings = cautionSideDialog.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.equal(
      cautionPromptings.length,
      3,
      'caution FBR should run one divergence round and two context-caution finalization prompts',
    );
    assert.ok(
      cautionPromptings[0]?.content.includes(cautionDivergence1),
      'caution FBR should start with the first divergence prompt',
    );
    assert.ok(
      cautionPromptings[1]?.content.includes(cautionFinalization1),
      'caution FBR should switch to context-caution finalization after context becomes tight',
    );
    assert.ok(
      cautionPromptings[2]?.content.includes(cautionFinalization2),
      'caution FBR should keep demanding a conclusion function while context remains tight',
    );
    assert.ok(
      !cautionPromptings.some((msg) => msg.content.includes(buildRoundBody(cautionBody, 2, 3))),
      'caution FBR should skip remaining divergence/convergence prompts',
    );
    const cautionFuncCalls = cautionSideDialog.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(cautionFuncCalls.length, 1, 'caution FBR should end via one model function call');
    assert.equal(cautionFuncCalls[0]?.name, FBR_LOW_NOISE_CONCLUSION_TOOL_NAME);

    const criticalRoot = await createMainDialog('tester');
    criticalRoot.disableDiligencePush = true;
    await driveDialogStream(
      criticalRoot,
      makeUserPrompt(criticalTrigger, 'kernel-driver-fbr-context-health-critical'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(criticalRoot) === criticalRootFinalAnswer,
      8_000,
      'FBR critical context final answer',
    );
    await waitForAllDialogsUnlocked(criticalRoot, 8_000);

    const criticalSideDialog = criticalRoot
      .getLoadedDialogTreeSnapshot()
      .find((dialog): dialog is SideDialog => dialog instanceof SideDialog);
    assert.ok(criticalSideDialog, 'expected critical FBR side dialog');
    const criticalPromptings = criticalSideDialog.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.equal(
      criticalPromptings.length,
      1,
      'critical FBR should hard-end without asking the model for another conclusion round',
    );
    assert.ok(
      criticalPromptings[0]?.content.includes(criticalDivergence1),
      'critical FBR should only persist the first divergence prompt before hard-ending',
    );
    const criticalFuncCalls = criticalSideDialog.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(
      criticalFuncCalls.length,
      0,
      'critical FBR should not fabricate or wait for a conclusion function call',
    );
  });

  console.log('kernel-driver fbr-context-health-closure: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver fbr-context-health-closure: FAIL\n${message}`);
  process.exit(1);
});
