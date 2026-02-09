import { Dialog, SubDialog } from '../../dialog';
import { buildNoToolsNotice } from '../../minds/system-prompt-parts';
import type { LanguageCode } from '../../shared/types/language';
import type { Team } from '../../team';
import type { CollectedTellaskCall } from '../../tellask';
import type { Tool } from '../../tool';
import type { ChatMessage } from '../client';

export type DriverV2TellaskPolicy = 'allow_any' | 'tellasker_only';

export type DriverV2PolicyMode = 'default' | 'fbr_toolless';

export type DriverV2PolicyState = Readonly<{
  mode: DriverV2PolicyMode;
  effectiveAgent: Team.Member;
  effectiveSystemPrompt: string;
  effectiveAgentTools: readonly Tool[];
  prependedContextMessages: readonly ChatMessage[];
  tellaskPolicy: DriverV2TellaskPolicy;
  allowFunctionCalls: boolean;
}>;

export type DriverV2PolicyViolationKind = 'tellask' | 'tool' | 'tellask_and_tool';

function isFbrSelfTellaskHeadLine(tellaskHead: string): boolean {
  return /^\s*@self\b/.test(tellaskHead);
}

function isToollessFbrSelfSubdialog(dlg: Dialog): dlg is SubDialog {
  return dlg instanceof SubDialog && isFbrSelfTellaskHeadLine(dlg.assignmentFromSup.tellaskHead);
}

function mergeModelParams(
  base: Team.ModelParams | undefined,
  overlay: Team.ModelParams | undefined,
): Team.ModelParams | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return overlay;
  if (!overlay) return base;
  return {
    max_tokens: overlay.max_tokens ?? base.max_tokens,
    codex: { ...(base.codex ?? {}), ...(overlay.codex ?? {}) },
    openai: { ...(base.openai ?? {}), ...(overlay.openai ?? {}) },
    anthropic: { ...(base.anthropic ?? {}), ...(overlay.anthropic ?? {}) },
  };
}

function buildFbrSystemPrompt(language: LanguageCode): string {
  const prefix =
    language === 'zh'
      ? [
          '# 扪心自问（FBR）支线对话',
          '',
          '- 你正在处理一次由 `!?@self` 发起的 FBR 支线对话。',
          '- 诉请正文是主要任务上下文；不要假设能访问诉请者对话历史。',
          '- 若使用可恢复的 `!tellaskSession` 形式，你可以使用本支线对话自身的 `tellaskSession` 历史作为显式上下文。',
          '- 若诉请正文缺少关键上下文，请在输出中列出缺失信息与阻塞原因。',
          '- 仅当必须澄清关键缺失上下文时，允许用 `!?@tellasker` 回问诉请者；除此之外不要发起任何诉请。',
        ].join('\n')
      : [
          '# Fresh Boots Reasoning (FBR) sideline dialog',
          '',
          '- This is an FBR sideline dialog created by `!?@self`.',
          '- The tellask body is the primary task context; do not assume access to tellasker dialog history.',
          '- If this is the resumable `!tellaskSession` form, you may use this sideline dialog’s own tellaskSession history as explicit context.',
          '- If the tellask body is missing critical context, list what is missing and why it blocks reasoning.',
          '- `!?@tellasker` is allowed only when you must clarify critical missing context; otherwise do not emit any tellasks.',
        ].join('\n');
  return prefix.trim();
}

export function buildDriverV2Policy(args: {
  dlg: Dialog;
  agent: Team.Member;
  systemPrompt: string;
  agentTools: readonly Tool[];
  language: LanguageCode;
}): DriverV2PolicyState {
  const { dlg, agent, systemPrompt, agentTools, language } = args;
  if (!isToollessFbrSelfSubdialog(dlg)) {
    return {
      mode: 'default',
      effectiveAgent: agent,
      effectiveSystemPrompt: systemPrompt,
      effectiveAgentTools: agentTools,
      prependedContextMessages: [],
      tellaskPolicy: 'allow_any',
      allowFunctionCalls: true,
    };
  }

  const effectiveAgent = Object.assign(Object.create(agent), {
    model_params: mergeModelParams(agent.model_params, agent.fbr_model_params),
  }) as Team.Member;

  return {
    mode: 'fbr_toolless',
    effectiveAgent,
    effectiveSystemPrompt: buildFbrSystemPrompt(language),
    effectiveAgentTools: [],
    prependedContextMessages: [
      {
        type: 'environment_msg',
        role: 'user',
        content: buildNoToolsNotice(language),
      },
    ],
    tellaskPolicy: 'tellasker_only',
    allowFunctionCalls: false,
  };
}

export function validateDriverV2PolicyInvariants(
  policy: DriverV2PolicyState,
  language: LanguageCode,
): { ok: true } | { ok: false; detail: string } {
  if (policy.mode !== 'fbr_toolless') {
    return { ok: true };
  }
  if (policy.effectiveAgentTools.length > 0) {
    return { ok: false, detail: 'FBR effectiveAgentTools must be empty.' };
  }
  if (policy.allowFunctionCalls) {
    return { ok: false, detail: 'FBR allowFunctionCalls must be false.' };
  }
  if (policy.tellaskPolicy !== 'tellasker_only') {
    return { ok: false, detail: 'FBR tellaskPolicy must be tellasker_only.' };
  }
  const expectedNoToolsNotice = buildNoToolsNotice(language);
  if (policy.prependedContextMessages.length !== 1) {
    return { ok: false, detail: 'FBR must prepend exactly one no-tools notice message.' };
  }
  const [notice] = policy.prependedContextMessages;
  if (
    !notice ||
    notice.type !== 'environment_msg' ||
    notice.role !== 'user' ||
    notice.content !== expectedNoToolsNotice
  ) {
    return {
      ok: false,
      detail: 'FBR prepended notice must exactly match buildNoToolsNotice(language).',
    };
  }
  return { ok: true };
}

function hasTellaskPolicyViolation(
  policy: DriverV2PolicyState,
  calls: ReadonlyArray<CollectedTellaskCall>,
): boolean {
  if (policy.tellaskPolicy === 'allow_any') {
    return false;
  }
  return calls.some((call) => {
    if (call.validation.kind !== 'valid') {
      return true;
    }
    return call.validation.firstMention !== 'tellasker';
  });
}

export function resolveDriverV2PolicyViolationKind(args: {
  policy: DriverV2PolicyState;
  tellaskCalls: ReadonlyArray<CollectedTellaskCall>;
  functionCallCount: number;
}): DriverV2PolicyViolationKind | null {
  const tellaskViolation = hasTellaskPolicyViolation(args.policy, args.tellaskCalls);
  const toolViolation = !args.policy.allowFunctionCalls && args.functionCallCount > 0;
  if (tellaskViolation && toolViolation) {
    return 'tellask_and_tool';
  }
  if (tellaskViolation) {
    return 'tellask';
  }
  if (toolViolation) {
    return 'tool';
  }
  return null;
}
