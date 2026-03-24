import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { Dialog, SubDialog } from '../../dialog';
import type { Team } from '../../team';
import type { Tool } from '../../tool';
import type { ChatMessage } from '../client';
import {
  buildFbrConclusionTools,
  buildFbrSystemPrompt,
  buildFbrToolAvailabilityNotice,
} from './fbr';

export type KernelDriverTellaskPolicy = 'allow_any' | 'deny_all';

export type KernelDriverPolicyMode = 'default' | 'fbr_toolless' | 'fbr_conclusion_only';

export type KernelDriverPolicyState = Readonly<{
  mode: KernelDriverPolicyMode;
  effectiveAgent: Team.Member;
  effectiveSystemPrompt: string;
  effectiveAgentTools: readonly Tool[];
  prependedContextMessages: readonly ChatMessage[];
  tellaskPolicy: KernelDriverTellaskPolicy;
  allowTellaskSpecialFunctions: boolean;
  allowFunctionCalls: boolean;
}>;

export type KernelDriverPolicyViolationKind = 'tellask' | 'tool' | 'tellask_and_tool';

function isToollessFbrSelfSubdialog(dlg: Dialog): dlg is SubDialog {
  if (!(dlg instanceof SubDialog)) return false;
  return dlg.assignmentFromSup.callName === 'freshBootsReasoning';
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

export function buildKernelDriverPolicy(args: {
  dlg: Dialog;
  agent: Team.Member;
  systemPrompt: string;
  agentTools: readonly Tool[];
  language: LanguageCode;
}): KernelDriverPolicyState {
  const { dlg, agent, systemPrompt, agentTools, language } = args;
  if (!isToollessFbrSelfSubdialog(dlg)) {
    return {
      mode: 'default',
      effectiveAgent: agent,
      effectiveSystemPrompt: systemPrompt,
      effectiveAgentTools: agentTools,
      prependedContextMessages: [],
      tellaskPolicy: 'allow_any',
      allowTellaskSpecialFunctions: true,
      allowFunctionCalls: true,
    };
  }

  const effectiveAgent = Object.assign(Object.create(agent), {
    model_params: mergeModelParams(agent.model_params, agent.fbr_model_params),
  }) as Team.Member;
  const isConclusionPhase = dlg.areFbrConclusionToolsEnabled();
  const mode: KernelDriverPolicyMode = isConclusionPhase ? 'fbr_conclusion_only' : 'fbr_toolless';
  const noticePhase = isConclusionPhase ? 'finalization' : 'toolless';

  return {
    mode,
    effectiveAgent,
    effectiveSystemPrompt: buildFbrSystemPrompt(language, noticePhase),
    effectiveAgentTools: isConclusionPhase ? buildFbrConclusionTools(language) : [],
    prependedContextMessages: [
      {
        type: 'environment_msg',
        role: 'user',
        content: buildFbrToolAvailabilityNotice(language, noticePhase),
      },
    ],
    tellaskPolicy: 'deny_all',
    allowTellaskSpecialFunctions: false,
    allowFunctionCalls: isConclusionPhase,
  };
}

export function validateKernelDriverPolicyInvariants(
  policy: KernelDriverPolicyState,
  language: LanguageCode,
): { ok: true } | { ok: false; detail: string } {
  if (policy.mode === 'default') {
    return { ok: true };
  }
  if (policy.tellaskPolicy !== 'deny_all') {
    return { ok: false, detail: 'FBR tellaskPolicy must be deny_all.' };
  }
  if (policy.allowTellaskSpecialFunctions) {
    return { ok: false, detail: 'FBR allowTellaskSpecialFunctions must be false.' };
  }
  if (policy.prependedContextMessages.length !== 1) {
    return { ok: false, detail: 'FBR must prepend exactly one no-tools notice message.' };
  }
  const expectedNotice = buildFbrToolAvailabilityNotice(
    language,
    policy.mode === 'fbr_conclusion_only' ? 'finalization' : 'toolless',
  );
  const [notice] = policy.prependedContextMessages;
  if (
    !notice ||
    notice.type !== 'environment_msg' ||
    notice.role !== 'user' ||
    notice.content !== expectedNotice
  ) {
    return {
      ok: false,
      detail: 'FBR prepended notice must exactly match the expected phase notice.',
    };
  }
  if (policy.mode === 'fbr_toolless') {
    if (policy.effectiveAgentTools.length > 0) {
      return { ok: false, detail: 'Tool-less FBR effectiveAgentTools must be empty.' };
    }
    if (policy.allowFunctionCalls) {
      return { ok: false, detail: 'Tool-less FBR allowFunctionCalls must be false.' };
    }
  }
  if (policy.mode === 'fbr_conclusion_only') {
    if (policy.effectiveAgentTools.length !== 2) {
      return {
        ok: false,
        detail: 'FBR conclusion-only mode must expose exactly two conclusion tools.',
      };
    }
    if (!policy.allowFunctionCalls) {
      return { ok: false, detail: 'FBR conclusion-only mode must allow function calls.' };
    }
  }
  return { ok: true };
}

function hasTellaskPolicyViolation(
  policy: KernelDriverPolicyState,
  tellaskCallCount: number,
): boolean {
  if (policy.tellaskPolicy === 'allow_any') {
    return false;
  }
  return tellaskCallCount > 0;
}

export function resolveKernelDriverPolicyViolationKind(args: {
  policy: KernelDriverPolicyState;
  tellaskCallCount: number;
  functionCallCount: number;
}): KernelDriverPolicyViolationKind | null {
  const tellaskViolation = hasTellaskPolicyViolation(args.policy, args.tellaskCallCount);
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
