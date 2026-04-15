import type { DialogDisplayTextI18n } from '@longrun-ai/kernel/types/display-state';

type HumanStopReasonKind =
  | 'aborted'
  | 'transport_interrupted'
  | 'malformed_stream'
  | 'conflicting_stream'
  | 'invalid_tool_call'
  | 'incomplete_tool_call_stream'
  | 'invalid_tool_context'
  | 'provider_rejected'
  | 'request_failed'
  | 'generic';

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function formatUpstreamRawMessage(detail: string, language: 'zh' | 'en'): string {
  const trimmed = detail.trim();
  if (trimmed === '') {
    return '';
  }
  return language === 'zh' ? `上游原文：${trimmed}` : `Upstream message: ${trimmed}`;
}

function inferHumanStopReasonKind(detail: string): HumanStopReasonKind {
  const lower = detail.toLowerCase();
  if (lower === 'aborted.' || lower === 'aborted') {
    return 'aborted';
  }
  if (lower.includes('unexpected eof')) {
    return 'transport_interrupted';
  }
  if (lower.includes('malformed stream event')) {
    return 'malformed_stream';
  }
  if (lower.includes('stream overlap violation') || lower.startsWith('protocol violation:')) {
    return 'conflicting_stream';
  }
  if (lower.includes('invalid tool call index')) {
    return 'invalid_tool_call';
  }
  if (lower.includes('incomplete function-call stream state')) {
    return 'incomplete_tool_call_stream';
  }
  if (lower.includes('tool_call_adjacency_violation') || lower.includes('tool call adjacency')) {
    return 'invalid_tool_context';
  }
  if (lower.includes('provider projection') || lower.includes('context reconstruction')) {
    return 'invalid_tool_context';
  }
  return 'generic';
}

function renderHumanStopReason(args: {
  language: 'zh' | 'en';
  kind: HumanStopReasonKind;
  detail: string;
  providerName?: string;
}): string {
  const providerText = isNonEmptyString(args.providerName)
    ? args.language === 'zh'
      ? `模型服务“${args.providerName}”`
      : `LLM provider '${args.providerName}'`
    : args.language === 'zh'
      ? '模型服务'
      : 'The LLM service';

  switch (args.kind) {
    case 'aborted':
      return args.language === 'zh' ? '已中止。' : 'Aborted.';
    case 'transport_interrupted':
      return args.language === 'zh'
        ? '与模型服务的连接意外中断，本次生成已停止。'
        : 'The connection to the LLM service ended unexpectedly. This generation was stopped.';
    case 'malformed_stream':
      return args.language === 'zh'
        ? '模型服务返回了格式异常的流式事件，本次生成已停止。'
        : 'The LLM service returned a malformed stream event. This generation was stopped.';
    case 'conflicting_stream':
      return args.language === 'zh'
        ? '模型服务返回了互相冲突的流式片段，本次生成已停止。'
        : 'The LLM service returned conflicting stream segments. This generation was stopped.';
    case 'invalid_tool_call':
      return args.language === 'zh'
        ? '模型服务返回了无效的工具调用信息，本次生成已停止。'
        : 'The LLM service returned invalid tool-call data. This generation was stopped.';
    case 'incomplete_tool_call_stream':
      return args.language === 'zh'
        ? '模型服务返回了不完整的工具调用流，本次生成已停止。'
        : 'The LLM service returned an incomplete tool-call stream. This generation was stopped.';
    case 'invalid_tool_context':
      return args.language === 'zh'
        ? '当前对话中的工具调用上下文不一致，本次生成已停止。'
        : 'The tool-call context in this dialog became inconsistent. This generation was stopped.';
    case 'provider_rejected':
      return args.language === 'zh'
        ? `${providerText}拒绝了这次请求，本次生成已停止。${formatUpstreamRawMessage(args.detail, 'zh')}`
        : `${providerText} rejected this request. This generation was stopped. ${formatUpstreamRawMessage(args.detail, 'en')}`;
    case 'request_failed':
      return args.language === 'zh'
        ? `本次生成因上游报错而停止。${formatUpstreamRawMessage(args.detail, 'zh')}`
        : `This generation was stopped because the upstream service returned an error. ${formatUpstreamRawMessage(args.detail, 'en')}`;
    case 'generic':
      return args.language === 'zh'
        ? `本次生成已因系统错误停止。${formatUpstreamRawMessage(args.detail, 'zh')}`
        : `This generation was stopped because of a system error. ${formatUpstreamRawMessage(args.detail, 'en')}`;
  }
}

export function buildHumanSystemStopReasonTextI18n(args: {
  detail: string;
  providerName?: string;
  kind?: Exclude<HumanStopReasonKind, 'generic'>;
  fallbackKind?: Exclude<HumanStopReasonKind, 'generic'>;
}): DialogDisplayTextI18n {
  const inferredKind = args.kind ?? inferHumanStopReasonKind(args.detail);
  const resolvedKind =
    inferredKind === 'generic' && args.fallbackKind !== undefined
      ? args.fallbackKind
      : inferredKind;
  return {
    zh: renderHumanStopReason({
      language: 'zh',
      kind: resolvedKind,
      detail: args.detail,
      providerName: args.providerName,
    }),
    en: renderHumanStopReason({
      language: 'en',
      kind: resolvedKind,
      detail: args.detail,
      providerName: args.providerName,
    }),
  };
}
