import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { DialogFbrState } from '@longrun-ai/kernel/types/storage';
import type { Dialog } from '../../dialog';
import { appendDistinctPerspectiveFbrBody } from '../../runtime/fbr-body';
import { formatAssignmentFromAskerDialog } from '../../runtime/inter-dialog-format';
import type { Team } from '../../team';
import { type FuncTool, type ToolArguments, type ToolCallOutput, toolSuccess } from '../../tool';
import type { ChatMessage, FuncCallMsg, FuncResultMsg } from '../client';

export const FBR_LOW_NOISE_CONCLUSION_TOOL_NAME = 'presentLowNoiseHighlyInformativeConclusion';
export const FBR_UNREASONABLE_SITUATION_TOOL_NAME = 'presentUnreasonableSituation';

export type FbrConclusionToolName =
  | typeof FBR_LOW_NOISE_CONCLUSION_TOOL_NAME
  | typeof FBR_UNREASONABLE_SITUATION_TOOL_NAME;

type FbrConclusionPhase = 'toolless' | 'finalization';

type FbrConclusionToolArgs = Readonly<{
  content: string;
}>;

export type FbrConclusionInspection =
  | Readonly<{
      kind: 'none';
    }>
  | Readonly<{
      kind: 'accepted';
      callId: string;
      toolName: FbrConclusionToolName;
      content: string;
      genseq: number;
    }>
  | Readonly<{
      kind: 'rejected';
      reason: string;
    }>;

function buildFbrConclusionToolDescription(args: {
  language: LanguageCode;
  kind: 'low_noise' | 'unreasonable';
}): string {
  if (args.language === 'zh') {
    return args.kind === 'low_noise'
      ? '仅在 FBR 已完成发散与收敛后使用。提交最终低噪高信息结论：只保留跨轮稳定共识、正文可支撑信息、必要未知项与最关键下一步；把孤立离谱想法当噪音丢弃。'
      : '仅在 FBR 已完成发散与收敛后使用。提交“当前现状无法被合理看待”的最终结论：明确说明为什么还不能形成负责的低噪结论，以及主要矛盾/缺口。';
  }
  return args.kind === 'low_noise'
    ? 'Use only after FBR divergence and convergence are complete. Submit the final low-noise, high-information conclusion: keep only stable cross-round consensus, body-grounded evidence, necessary unknowns, and the most important next step; discard isolated wild ideas as noise.'
    : 'Use only after FBR divergence and convergence are complete. Submit the final conclusion that the current situation cannot yet be viewed reasonably: state why a responsible low-noise conclusion is still not possible, and name the main contradictions or gaps.';
}

function extractFbrConclusionToolArgs(rawArgs: ToolArguments): FbrConclusionToolArgs {
  const content = rawArgs['content'];
  if (typeof content !== 'string') {
    throw new Error('FBR conclusion tool invariant violation: content must be a string.');
  }
  const normalized = content.trim();
  if (normalized === '') {
    throw new Error('FBR conclusion tool invariant violation: content must not be empty.');
  }
  return { content: normalized };
}

async function callFbrConclusionTool(
  _dlg: Dialog,
  _caller: Team.Member,
  rawArgs: ToolArguments,
): Promise<ToolCallOutput> {
  return toolSuccess(extractFbrConclusionToolArgs(rawArgs).content);
}

export function buildFbrConclusionTools(language: LanguageCode): readonly FuncTool[] {
  return [
    {
      type: 'func',
      name: FBR_LOW_NOISE_CONCLUSION_TOOL_NAME,
      followupMode: 'deferred',
      description: buildFbrConclusionToolDescription({ language, kind: 'low_noise' }),
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              language === 'zh'
                ? '最终低噪高信息结论正文。只保留稳定共识；把未获独立支撑的离谱想法视为噪音丢弃。'
                : 'Final low-noise, high-information conclusion body. Keep only stable consensus; discard unsupported wild ideas as noise.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      call: callFbrConclusionTool,
    },
    {
      type: 'func',
      name: FBR_UNREASONABLE_SITUATION_TOOL_NAME,
      followupMode: 'deferred',
      description: buildFbrConclusionToolDescription({ language, kind: 'unreasonable' }),
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              language === 'zh'
                ? '最终“不合理现状”结论正文。说明为什么当前还不能形成负责的低噪结论。'
                : 'Final "unreasonable situation" conclusion body. Explain why a responsible low-noise conclusion is still not possible.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      call: callFbrConclusionTool,
    },
  ];
}

export function isFbrConclusionToolName(name: string): name is FbrConclusionToolName {
  return (
    name === FBR_LOW_NOISE_CONCLUSION_TOOL_NAME || name === FBR_UNREASONABLE_SITUATION_TOOL_NAME
  );
}

export function buildFbrToolAvailabilityNotice(
  language: LanguageCode,
  phase: FbrConclusionPhase,
): string {
  if (phase === 'toolless') {
    return language === 'zh'
      ? 'FBR 当前阶段无工具：不能调用任何函数，也不能访问 rtws / 文件 / 浏览器 / shell。'
      : 'Current FBR phase has no tools: do not call any functions, and do not access the rtws, files, browser, or shell.';
  }

  return language === 'zh'
    ? `FBR 当前阶段仅开放两个结论函数：\`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}\` / \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}\`。除此之外，仍禁止任何其它函数调用，也不能访问 rtws / 文件 / 浏览器 / shell。`
    : `Current FBR phase exposes exactly two conclusion functions: \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}\` / \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}\`. All other function calls remain forbidden, and you still have no access to the rtws, files, browser, or shell.`;
}

export function buildFbrSystemPrompt(language: LanguageCode, phase: FbrConclusionPhase): string {
  if (language === 'zh') {
    return [
      '# 扪心自问（FBR）支线对话',
      '',
      '- 你正在处理一次由 `freshBootsReasoning` 触发的 FBR 支线对话。',
      '- 诉请正文是主要任务上下文；不要假设能访问诉请者一侧的对话历史。',
      '- 若使用可恢复会话，你可以使用本支线对话自身的会话历史作为显式上下文。',
      '- 发散阶段要对反直觉、离谱、少数派的候选想法保持开放，把它们当作待检验候选，而不是提前镇压。',
      '- 收敛阶段要自主去噪：只保留跨轮稳定共识、彼此能互证且能被诉请正文支撑的内容；未获独立支撑的离谱想法默认当噪音丢弃，不进入最终结论。',
      '- 若关键上下文缺失，请明确指出缺口以及它为什么阻塞形成负责结论。',
      phase === 'toolless'
        ? '- 当前尚未进入最终收口阶段：先继续发散或收敛，不可调用任何函数。'
        : `- 当前已进入最终收口阶段：必须且只能调用 \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}\` 或 \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}\` 之一结束；不要以普通文本结束。`,
    ].join('\n');
  }

  return [
    '# Fresh Boots Reasoning (FBR) Side Dialog',
    '',
    '- You are handling an FBR Side Dialog triggered by `freshBootsReasoning`.',
    '- The tellask body is the primary task context; do not assume access to tellasker-side dialog history.',
    '- If this is a resumable session, you may use this Side Dialog’s own session history as explicit context.',
    '- In divergence, stay open to counterintuitive, wild, or minority hypotheses; treat them as candidates to test instead of suppressing them early.',
    '- In convergence, denoise autonomously: keep only stable cross-round consensus, mutually reinforcing points, and body-grounded evidence; unsupported wild ideas default to noise and must not enter the final conclusion.',
    '- If critical context is missing, state what is missing and why it blocks a responsible conclusion.',
    phase === 'toolless'
      ? '- You are not yet in the finalization phase: continue diverging or converging, and do not call any functions.'
      : `- You are now in the finalization phase: you must end by calling exactly one of \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}\` or \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}\`; do not end with plain text.`,
  ].join('\n');
}

export function buildFbrConvergencePrompt(args: {
  iteration: number;
  total: number;
  language: LanguageCode;
}): string {
  if (args.language === 'zh') {
    return [
      `【第 ${args.iteration}/${args.total} 轮收敛】不要急于下结论，再多想想。`,
      '',
      '现在开始主动去噪，而不是继续扩写奇想：',
      '- 对前面出现过的离谱、激进、反直觉想法保持开放心态，但把它们先视为候选噪音而不是既定结论。',
      '- 只保留跨轮重复出现、彼此能相互印证、并且能被诉请正文直接支撑的稳定共识。',
      '- 单轮惊艳但孤立、缺少支撑、只靠想象才能成立的想法，默认视为噪音丢弃，不进入最终结论。',
      '- 只有当一个看似离谱的想法后来获得独立支撑，或与多轮共识汇合时，才允许保留。',
      '- 这一轮先继续收敛、核对、压缩稳定部分；不要调用任何结论函数。',
    ].join('\n');
  }

  return [
    `[Convergence round ${args.iteration}/${args.total}] Do not rush to a conclusion yet; think a bit more.`,
    '',
    'Denoise now instead of expanding the wildest branches:',
    '- Stay open to earlier strange, aggressive, or counterintuitive ideas, but treat them as candidate noise rather than established conclusions.',
    '- Keep only stable cross-round consensus, mutually reinforcing points, and claims directly supported by the tellask body.',
    '- A one-round flashy idea that stays isolated, weakly supported, or imagination-dependent should be discarded as noise and must not enter the final conclusion.',
    '- A seemingly wild idea may survive only if it later gains independent support or merges into multi-round consensus.',
    '- In this round, keep converging, checking, and compressing the stable core; do not call any conclusion function yet.',
  ].join('\n');
}

export function buildFbrFinalizationPrompt(args: {
  attempt: number;
  total: number;
  language: LanguageCode;
}): string {
  if (args.language === 'zh') {
    const retryLine =
      args.attempt <= 1
        ? '现在进入 FBR 最终收口。'
        : `前一次仍未用规定函数完成收口；这是第 ${args.attempt}/${args.total} 次最终收口提醒。`;
    return [
      retryLine,
      '',
      `你现在必须且只能调用以下两个函数之一结束本次 FBR：`,
      `- \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}({ content })\``,
      `- \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}({ content })\``,
      '',
      '选择规则：',
      '- 如果已经形成稳定共识：调用低噪高信息结论函数。',
      '- 如果仍然相互矛盾、证据不足、关键上下文缺失，导致你无法负责地给出低噪结论：调用“不合理现状”函数。',
      '',
      '强制要求：',
      '- 不要再输出普通文本，不要继续展开分析。',
      '- 最终 content 里只保留稳定共识、关键未知项、最重要的下一步。',
      '- 前面那些离谱但未获独立支撑的想法，一律当噪音丢弃，不得进入最终 content。',
    ].join('\n');
  }

  const retryLine =
    args.attempt <= 1
      ? 'You are now in final FBR closure.'
      : `The previous attempt still did not end via the required function. This is finalization prompt ${args.attempt}/${args.total}.`;
  return [
    retryLine,
    '',
    'You must now end this FBR by calling exactly one of:',
    `- \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}({ content })\``,
    `- \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}({ content })\``,
    '',
    'Choose as follows:',
    '- If stable consensus exists, call the low-noise highly-informative conclusion function.',
    '- If contradictions, lack of evidence, or missing context still block a responsible low-noise conclusion, call the unreasonable-situation function.',
    '',
    'Hard requirements:',
    '- Do not output plain text and do not keep expanding analysis.',
    '- The final content must keep only stable consensus, key unknowns, and the single most important next steps.',
    '- Earlier wild ideas that never gained independent support must be discarded as noise and must not appear in the final content.',
  ].join('\n');
}

export function buildFbrContextCautionFinalizationPrompt(args: {
  attempt: number;
  language: LanguageCode;
}): string {
  if (args.language === 'zh') {
    const retryLine =
      args.attempt <= 1
        ? 'FBR 上下文状态：🟡 吃紧'
        : `FBR 上下文仍然吃紧；这是第 ${args.attempt} 次要求你用结论函数收口。`;
    return [
      retryLine,
      '',
      '当前 FBR 已经因为上下文压力提前进入最终收口。把这视为问题复杂度、推理成本或噪音累积已经不适合继续发散/收敛的信号。',
      '',
      `现在必须且只能调用以下两个函数之一结束本次 FBR：`,
      `- \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}({ content })\``,
      `- \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}({ content })\``,
      '',
      '选择规则：',
      '- 如果基于已经完成的发散、收敛推演，仍能形成稳定共识：调用低噪高信息结论函数。',
      '- 如果已有推演仍相互矛盾、证据不足、关键上下文缺失，或上下文吃紧本身说明问题过于复杂：调用“不合理现状”函数。',
      '',
      '强制要求：',
      '- 不要 clear_mind，不要继续发散/收敛，不要调用其它函数，不要输出普通文本。',
      '- content 必须由你基于已经做过的推演自行形成；运行时不会替你程序化转译或代写结论。',
      '- 最终 content 只保留稳定共识、关键未知项、最重要的下一步；未获独立支撑的离谱想法必须当噪音丢弃。',
    ].join('\n');
  }

  const retryLine =
    args.attempt <= 1
      ? 'FBR context state: 🟡 caution'
      : `FBR context is still tight; this is reminder ${args.attempt} requiring you to close through a conclusion function.`;
  return [
    retryLine,
    '',
    'This FBR is entering final closure early because of context pressure. Treat that as a signal that problem complexity, reasoning cost, or accumulated noise is no longer suitable for continued divergence/convergence.',
    '',
    'You must now end this FBR by calling exactly one of:',
    `- \`${FBR_LOW_NOISE_CONCLUSION_TOOL_NAME}({ content })\``,
    `- \`${FBR_UNREASONABLE_SITUATION_TOOL_NAME}({ content })\``,
    '',
    'Choose as follows:',
    '- If the divergence/convergence already performed still supports stable consensus, call the low-noise highly-informative conclusion function.',
    '- If the existing reasoning remains contradictory, under-evidenced, missing key context, or context pressure itself shows the problem is too complex, call the unreasonable-situation function.',
    '',
    'Hard requirements:',
    '- Do not clear_mind, do not keep diverging/converging, do not call any other function, and do not output plain text.',
    '- The content must be formed by you from the reasoning already performed; the runtime will not programmatically translate or write the conclusion for you.',
    '- Keep only stable consensus, key unknowns, and the single most important next steps; discard unsupported wild ideas as noise.',
  ].join('\n');
}

export function buildProgrammaticFbrContextCriticalContent(args: {
  language: LanguageCode;
}): string {
  if (args.language === 'zh') {
    return [
      '当前 FBR 问题过于复杂，不能继续负责地扩展推理，也不能在剩余上下文内形成可靠的低噪结论。',
      '',
      '原因：',
      '- 上下文已经达到告急水平；这本身应视为问题复杂度、证据需求或推理分支数量超过当前 FBR 可控范围的信号。',
      '- Dominds 不会在告急状态下程序化总结对话、抽取已有推演或替模型转译结论；那会显著提高遗漏、失真和幻觉风险。',
      '',
      '建议：',
      '- 将诉请拆解为更小、更清晰的子问题。',
      '- 为每个子问题分别固定 Goal / Facts / Constraints / Evidence / Unknowns 后，各自重新发起 FBR。',
    ].join('\n');
  }

  return [
    'This FBR problem is too complex to keep expanding reasoning responsibly or produce a reliable low-noise conclusion within the remaining context.',
    '',
    'Reasons:',
    '- Context has reached the critical level; this should itself be treated as a signal that problem complexity, evidence needs, or branch count exceeded what the current FBR can control.',
    '- Dominds will not programmatically summarize the dialog, extract existing reasoning, or translate it into a conclusion under critical context pressure; doing so would materially increase omission, distortion, and hallucination risk.',
    '',
    'Suggested next steps:',
    '- Split the request into smaller, clearer subproblems.',
    '- For each subproblem, stabilize Goal / Facts / Constraints / Evidence / Unknowns, then run its own FBR pass.',
  ].join('\n');
}

export function buildProgrammaticFbrUnreasonableSituationContent(args: {
  language: LanguageCode;
  finalizationAttempts: number;
}): string {
  if (args.language === 'zh') {
    return [
      '当前现状无法被合理看待并收束成负责的低噪结论。',
      '',
      '原因：',
      `- 在完成既定的发散轮与收敛轮之后，模型仍连续 ${args.finalizationAttempts} 次未能按要求调用正式结论函数完成收口。`,
      '- 这说明当前推理状态仍未稳定到可交付的程度；若强行给出结论，噪音和幻觉风险过高。',
      '',
      '建议：',
      '- 将现有文本重新整理为更清晰的 Goal / Facts / Constraints / Evidence / Unknowns。',
      '- 补充最关键缺失证据后，再重新发起一次 FBR。',
    ].join('\n');
  }

  return [
    'The current situation cannot yet be viewed reasonably enough to close into a responsible low-noise conclusion.',
    '',
    'Reasons:',
    `- After completing the planned divergence and convergence rounds, the model still failed ${args.finalizationAttempts} times in a row to end via the required conclusion function.`,
    '- This indicates the reasoning state never stabilized enough for safe delivery; forcing a conclusion would keep too much noise and hallucination risk.',
    '',
    'Suggested next steps:',
    '- Reframe the input more clearly as Goal / Facts / Constraints / Evidence / Unknowns.',
    '- Add the most critical missing evidence, then run a new FBR pass.',
  ].join('\n');
}

function parseFbrConclusionContent(
  call: FuncCallMsg,
): { ok: true; content: string } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    const content = (parsed as Record<string, unknown>)['content'];
    if (typeof content !== 'string') {
      return { ok: false };
    }
    const normalized = content.trim();
    if (normalized === '') {
      return { ok: false };
    }
    return { ok: true, content: normalized };
  } catch {
    return { ok: false };
  }
}

function isAcceptedFbrConclusionResult(result: FuncResultMsg | undefined): boolean {
  if (!result) return false;
  if (typeof result.content !== 'string') return false;
  if (result.content.startsWith('Invalid arguments:')) return false;
  if (result.content.startsWith("Function '")) return false;
  return result.content.trim() !== '';
}

export function inspectFbrConclusionAttempt(
  messages: readonly ChatMessage[],
): FbrConclusionInspection {
  const calls = messages.filter(
    (msg): msg is FuncCallMsg => msg.type === 'func_call_msg' && isFbrConclusionToolName(msg.name),
  );
  if (calls.length === 0) {
    return { kind: 'none' };
  }
  if (calls.length > 1) {
    return {
      kind: 'rejected',
      reason: `expected exactly one FBR conclusion call, got ${calls.length}`,
    };
  }

  const call = calls[0];
  const parsed = parseFbrConclusionContent(call);
  if (!parsed.ok) {
    return {
      kind: 'rejected',
      reason: `FBR conclusion call ${call.name} has invalid arguments`,
    };
  }

  const result = messages.find(
    (msg): msg is FuncResultMsg => msg.type === 'func_result_msg' && msg.id === call.id,
  );
  if (!isAcceptedFbrConclusionResult(result)) {
    return {
      kind: 'rejected',
      reason: `FBR conclusion call ${call.name} did not yield an accepted tool result`,
    };
  }

  return {
    kind: 'accepted',
    callId: call.id,
    toolName: call.name as FbrConclusionToolName,
    content: parsed.content,
    genseq: call.genseq,
  };
}

export function createInitialFbrState(effort: number): DialogFbrState {
  if (!Number.isFinite(effort) || !Number.isInteger(effort) || effort < 1) {
    throw new Error(`Invalid FBR effort: ${String(effort)}`);
  }
  return {
    kind: 'serial',
    effort,
    phase: 'divergence',
    iteration: 1,
    promptDelivered: false,
  };
}

export function markFbrPromptDelivered(state: DialogFbrState): DialogFbrState {
  return {
    ...state,
    promptDelivered: true,
  };
}

export function isFbrFinalizationState(state: DialogFbrState): boolean {
  return state.phase === 'finalization';
}

export function isFbrContextCautionFinalizationState(state: DialogFbrState): boolean {
  return state.phase === 'finalization' && state.finalizationReason === 'context_caution';
}

export function forceFbrContextCautionFinalizationState(state: DialogFbrState): DialogFbrState {
  if (state.phase === 'finalization') {
    return {
      ...state,
      finalizationReason: 'context_caution',
      promptDelivered: false,
    };
  }
  return {
    kind: 'serial',
    effort: state.effort,
    phase: 'finalization',
    iteration: 1,
    promptDelivered: false,
    finalizationReason: 'context_caution',
  };
}

export function advanceFbrState(state: DialogFbrState): DialogFbrState | undefined {
  switch (state.phase) {
    case 'divergence': {
      if (state.iteration < state.effort) {
        return {
          kind: 'serial',
          effort: state.effort,
          phase: 'divergence',
          iteration: state.iteration + 1,
          promptDelivered: false,
        };
      }
      return {
        kind: 'serial',
        effort: state.effort,
        phase: 'convergence',
        iteration: 1,
        promptDelivered: false,
      };
    }
    case 'convergence': {
      if (state.iteration < state.effort) {
        return {
          kind: 'serial',
          effort: state.effort,
          phase: 'convergence',
          iteration: state.iteration + 1,
          promptDelivered: false,
        };
      }
      return {
        kind: 'serial',
        effort: state.effort,
        phase: 'finalization',
        iteration: 1,
        promptDelivered: false,
        finalizationReason: 'planned',
      };
    }
    case 'finalization': {
      if (state.finalizationReason === 'context_caution') {
        return {
          kind: 'serial',
          effort: state.effort,
          phase: 'finalization',
          iteration: state.iteration + 1,
          promptDelivered: false,
          finalizationReason: 'context_caution',
        };
      }
      if (state.iteration >= state.effort) {
        return undefined;
      }
      return {
        kind: 'serial',
        effort: state.effort,
        phase: 'finalization',
        iteration: state.iteration + 1,
        promptDelivered: false,
        finalizationReason: 'planned',
      };
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function buildFbrPromptForState(args: {
  state: DialogFbrState;
  tellaskContent: string;
  fromAgentId: string;
  toAgentId: string;
  language: LanguageCode;
  collectiveTargets?: string[];
}): string {
  switch (args.state.phase) {
    case 'divergence':
      return formatAssignmentFromAskerDialog({
        callName: 'freshBootsReasoning',
        fromAgentId: args.fromAgentId,
        toAgentId: args.toAgentId,
        tellaskContent: appendDistinctPerspectiveFbrBody({
          body: args.tellaskContent,
          iteration: args.state.iteration,
          total: args.state.effort,
          language: args.language,
          isFinalRound: args.state.iteration === args.state.effort,
        }),
        language: args.language,
        collectiveTargets: args.collectiveTargets,
        fbrRound: {
          iteration: args.state.iteration,
          total: args.state.effort,
        },
      });
    case 'convergence':
      return buildFbrConvergencePrompt({
        iteration: args.state.iteration,
        total: args.state.effort,
        language: args.language,
      });
    case 'finalization':
      if (args.state.finalizationReason === 'context_caution') {
        return buildFbrContextCautionFinalizationPrompt({
          attempt: args.state.iteration,
          language: args.language,
        });
      }
      return buildFbrFinalizationPrompt({
        attempt: args.state.iteration,
        total: args.state.effort,
        language: args.language,
      });
    default: {
      const _exhaustive: never = args.state;
      return _exhaustive;
    }
  }
}
