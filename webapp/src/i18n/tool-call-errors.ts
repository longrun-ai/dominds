import type { LanguageCode } from '../shared/types/language';

export type ToolCallErrorCode = 'ERR_UNKNOWN_CALL' | 'ERR_TOOL_EXECUTION';

type ParsedToolCallError =
  | { code: 'ERR_UNKNOWN_CALL' }
  | { code: 'ERR_TOOL_EXECUTION'; detail?: string };

export function parseToolCallError(result: string): ParsedToolCallError | null {
  const trimmed = result.trim();
  if (trimmed === '') return null;

  const firstNewline = trimmed.indexOf('\n');
  const firstLine = (firstNewline >= 0 ? trimmed.slice(0, firstNewline) : trimmed).trim();
  const rest = firstNewline >= 0 ? trimmed.slice(firstNewline + 1).trim() : '';

  if (firstLine === 'ERR_UNKNOWN_CALL') return { code: 'ERR_UNKNOWN_CALL' };
  if (firstLine === 'ERR_TOOL_EXECUTION') {
    return rest ? { code: 'ERR_TOOL_EXECUTION', detail: rest } : { code: 'ERR_TOOL_EXECUTION' };
  }

  return null;
}

export function formatToolCallErrorInline(options: {
  language: LanguageCode;
  responderId: string;
  headLine: string;
  parsed: ParsedToolCallError;
}): string {
  if (options.parsed.code === 'ERR_UNKNOWN_CALL') {
    if (options.language === 'zh') {
      return `未知诉请：@${options.responderId}\n标题：${options.headLine}`;
    }
    return `Unknown call: @${options.responderId}\nHead: ${options.headLine}`;
  }

  if (options.language === 'zh') {
    const detail = options.parsed.detail ? `\n详情：\n${options.parsed.detail}` : '';
    return `执行 @${options.responderId} 出错\n标题：${options.headLine}${detail}`;
  }
  const detail = options.parsed.detail ? `\nDetail:\n${options.parsed.detail}` : '';
  return `Error executing @${options.responderId}\nHead: ${options.headLine}${detail}`;
}
