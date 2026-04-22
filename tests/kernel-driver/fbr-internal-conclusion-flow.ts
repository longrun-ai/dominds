import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SideDialog } from '../../main/dialog';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  buildFbrConvergencePrompt,
  buildFbrFinalizationPrompt,
  buildProgrammaticFbrUnreasonableSituationContent,
  FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
} from '../../main/llm/kernel-driver/fbr';
import { DialogPersistence } from '../../main/persistence';
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

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('zh');
    await writeStandardMinds(tmpRoot);
    await writeFbrTeamYaml(tmpRoot, 2);

    const language = getWorkLanguage();

    const successTrigger = '发起一次会正常收口的 FBR。';
    const successBody = [
      'Goal: 判断当前现象最可信的解释。',
      'Facts:',
      '- 线索 A 更稳定。',
      '- 线索 B 可能只是偶发噪音。',
      'Constraint:',
      '- 只能基于正文推理。',
    ].join('\n');
    const successFinalContent = [
      '低噪结论：当前最可信的判断是线索 A 指向主因，线索 B 暂时只应视作噪音。',
      '关键未知项：还缺一条直接证据来最终封口。',
      '下一步：优先补那条直接证据，而不是继续扩写边缘猜想。',
    ].join('\n');
    const successMirroredResponse = formatTellaskResponseContent({
      callName: 'freshBootsReasoning',
      callId: 'fbr-success-call',
      responderId: 'tester',
      requesterId: 'tester',
      tellaskContent: successBody,
      responseBody: successFinalContent,
      status: 'completed',
      language,
    });
    const successRootFinalAnswer = '主线已收到低噪 FBR 结论。';

    const fallbackTrigger = '发起一次会走程序化兜底的 FBR。';
    const fallbackBody = [
      'Goal: 判断当前现象是否已经足够可解释。',
      'Facts:',
      '- 线索互相打架。',
      '- 没有哪条证据足够稳定。',
      'Constraint:',
      '- 只能基于正文推理。',
    ].join('\n');
    const fallbackFinalContent = buildProgrammaticFbrUnreasonableSituationContent({
      language,
      finalizationAttempts: 2,
    });
    const fallbackMirroredResponse = formatTellaskResponseContent({
      callName: 'freshBootsReasoning',
      callId: 'fbr-fallback-call',
      responderId: 'tester',
      requesterId: 'tester',
      tellaskContent: fallbackBody,
      responseBody: fallbackFinalContent,
      status: 'completed',
      language,
    });
    const fallbackRootFinalAnswer = '主线已收到程序化不合理现状结论。';

    const successDivergence1 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(successBody, 1, 2),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 1, total: 2 },
    });
    const successDivergence2 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(successBody, 2, 2),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 2, total: 2 },
    });

    const fallbackDivergence1 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(fallbackBody, 1, 2),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 1, total: 2 },
    });
    const fallbackDivergence2 = formatAssignmentFromAskerDialog({
      callName: 'freshBootsReasoning',
      fromAgentId: 'tester',
      toAgentId: 'tester',
      tellaskContent: buildRoundBody(fallbackBody, 2, 2),
      language,
      collectiveTargets: ['tester'],
      fbrRound: { iteration: 2, total: 2 },
    });

    const convergence1 = buildFbrConvergencePrompt({ iteration: 1, total: 2, language });
    const convergence2 = buildFbrConvergencePrompt({ iteration: 2, total: 2, language });
    const finalization1 = buildFbrFinalizationPrompt({ attempt: 1, total: 2, language });
    const finalization2 = buildFbrFinalizationPrompt({ attempt: 2, total: 2, language });

    await writeMockDb(tmpRoot, [
      {
        message: successTrigger,
        role: 'user',
        response: '开始做 FBR。',
        funcCalls: [
          {
            id: 'fbr-success-call',
            name: 'freshBootsReasoning',
            arguments: { tellaskContent: successBody, effort: 2 },
          },
        ],
      },
      {
        message: successDivergence1,
        role: 'user',
        response: '发散一：假设最稳定线索已经足够说明主因。',
      },
      {
        message: successDivergence2,
        role: 'user',
        response: '发散二：允许 B 是离谱噪音，不急着压掉，但先保留为候选噪音。',
      },
      {
        message: convergence1,
        role: 'user',
        response: '收敛一：跨轮稳定部分仍然主要围绕线索 A。',
        contextContains: [successBody],
      },
      {
        message: convergence2,
        role: 'user',
        response: '收敛二：线索 B 缺少独立支撑，应从最终结论里丢弃。',
        contextContains: [successBody],
      },
      {
        message: finalization1,
        role: 'user',
        response: '',
        contextContains: [successBody],
        funcCalls: [
          {
            id: 'fbr-success-finalizer',
            name: FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
            arguments: { content: successFinalContent },
          },
        ],
      },
      {
        message: successMirroredResponse,
        role: 'tool',
        response: successRootFinalAnswer,
      },
      {
        message: fallbackTrigger,
        role: 'user',
        response: '开始做一轮会失败收口的 FBR。',
        funcCalls: [
          {
            id: 'fbr-fallback-call',
            name: 'freshBootsReasoning',
            arguments: { tellaskContent: fallbackBody, effort: 2 },
          },
        ],
      },
      {
        message: fallbackDivergence1,
        role: 'user',
        response: '发散一：假设所有线索都可能指向不同方向。',
      },
      {
        message: fallbackDivergence2,
        role: 'user',
        response: '发散二：允许互相冲突的解释暂时并存。',
      },
      {
        message: convergence1,
        role: 'user',
        response: '收敛一：目前仍没有稳定共识。',
        contextContains: [fallbackBody],
      },
      {
        message: convergence2,
        role: 'user',
        response: '收敛二：冲突依旧，噪音过高。',
        contextContains: [fallbackBody],
      },
      {
        message: finalization1,
        role: 'user',
        response: '我还没准备好调用结论函数。',
        contextContains: [fallbackBody],
      },
      {
        message: finalization2,
        role: 'user',
        response: '我还是没有按要求调用结论函数。',
        contextContains: [fallbackBody],
      },
      {
        message: fallbackMirroredResponse,
        role: 'tool',
        response: fallbackRootFinalAnswer,
      },
    ]);

    const successRoot = await createMainDialog('tester');
    successRoot.disableDiligencePush = true;

    await driveDialogStream(
      successRoot,
      makeUserPrompt(successTrigger, 'kernel-driver-fbr-internal-conclusion-flow-success'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(successRoot) === successRootFinalAnswer,
      8_000,
      'successful FBR root final answer',
    );
    await waitForAllDialogsUnlocked(successRoot, 8_000);

    const successSideDialog = successRoot
      .getAllDialogs()
      .find((dialog): dialog is SideDialog => dialog instanceof SideDialog);
    assert.ok(successSideDialog, 'expected FBR success sideDialog to exist');
    assert.equal(
      successSideDialog.assignmentFromAsker.effectiveFbrEffort,
      2,
      'successful FBR sideDialog should record the effective effort on assignment metadata',
    );
    const successPersistedMeta = await DialogPersistence.loadDialogMetadata(
      successSideDialog.id,
      'running',
    );
    assert.equal(
      successPersistedMeta?.assignmentFromAsker?.effectiveFbrEffort,
      2,
      'successful FBR metadata persisted to disk should keep the effective effort',
    );

    const successPromptings = successSideDialog.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.equal(
      successPromptings.length,
      5,
      'successful FBR should run 2 divergence rounds + 2 convergence rounds + 1 finalization round before ending',
    );
    assert.ok(
      successPromptings.every(
        (msg) =>
          !msg.content.includes('[Dominds 当前无跨对话回复义务]') &&
          !msg.content.includes('这轮不要调用任何 `reply*`'),
      ),
      'FBR prompts should stay isolated from ordinary inter-dialog reply-obligation guidance',
    );
    const successFuncCalls = successSideDialog.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(
      successFuncCalls.length,
      1,
      'successful FBR should end with exactly one conclusion function call',
    );
    assert.equal(
      successFuncCalls[0]?.name,
      FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
      'successful FBR should close with the low-noise conclusion function',
    );

    const successTellaskResult = successRoot.msgs.find(
      (msg): msg is Extract<(typeof successRoot.msgs)[number], { type: 'tellask_result_msg' }> =>
        msg.type === 'tellask_result_msg' && msg.content === successMirroredResponse,
    );
    assert.ok(
      successTellaskResult,
      'expected successful FBR tellask result to be mirrored to root',
    );
    assert.ok(
      successTellaskResult.content.includes(successFinalContent),
      'root should receive the final low-noise conclusion body',
    );
    assert.ok(
      !successTellaskResult.content.includes('FBR 全量回帖') &&
        !successTellaskResult.content.includes('收到全量回帖后请提炼'),
      'root must no longer receive raw all-round FBR dumps or requester distill instructions',
    );

    const fallbackRoot = await createMainDialog('tester');
    fallbackRoot.disableDiligencePush = true;

    await driveDialogStream(
      fallbackRoot,
      makeUserPrompt(fallbackTrigger, 'kernel-driver-fbr-internal-conclusion-flow-fallback'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => lastAssistantSaying(fallbackRoot) === fallbackRootFinalAnswer,
      8_000,
      'fallback FBR root final answer',
    );
    await waitForAllDialogsUnlocked(fallbackRoot, 8_000);

    const fallbackSideDialog = fallbackRoot
      .getAllDialogs()
      .find((dialog): dialog is SideDialog => dialog instanceof SideDialog);
    assert.ok(fallbackSideDialog, 'expected fallback FBR sideDialog to exist');
    assert.equal(
      fallbackSideDialog.assignmentFromAsker.effectiveFbrEffort,
      2,
      'fallback FBR sideDialog should also record the effective effort on assignment metadata',
    );

    const fallbackPromptings = fallbackSideDialog.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.equal(
      fallbackPromptings.length,
      6,
      'fallback FBR should run 2 divergence rounds + 2 convergence rounds + 2 finalization retries before runtime fallback',
    );
    assert.ok(
      fallbackPromptings.every(
        (msg) =>
          !msg.content.includes('[Dominds 当前无跨对话回复义务]') &&
          !msg.content.includes('这轮不要调用任何 `reply*`'),
      ),
      'fallback FBR prompts should also avoid ordinary inter-dialog reply-obligation guidance',
    );
    const fallbackFuncCalls = fallbackSideDialog.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(
      fallbackFuncCalls.length,
      0,
      'fallback scenario should reach programmatic unreasonable-situation conclusion because the model never called a conclusion function',
    );

    const fallbackTellaskResult = fallbackRoot.msgs.find(
      (msg): msg is Extract<(typeof fallbackRoot.msgs)[number], { type: 'tellask_result_msg' }> =>
        msg.type === 'tellask_result_msg' && msg.content === fallbackMirroredResponse,
    );
    assert.ok(fallbackTellaskResult, 'expected fallback tellask result to be mirrored to root');
    assert.ok(
      fallbackTellaskResult.content.includes(fallbackFinalContent),
      'root should receive the runtime-generated unreasonable-situation conclusion',
    );
  });

  console.log('kernel-driver fbr-internal-conclusion-flow: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver fbr-internal-conclusion-flow: FAIL\n${message}`);
  process.exit(1);
});
