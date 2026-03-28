export const DEFAULT_TOOL_OUTPUT_CHAR_LIMIT = 48_000;

export type ToolOutputTruncationResult = Readonly<{
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
  limitChars: number;
}>;

export type ToolOutputTruncationOptions = Readonly<{
  limitChars?: number;
  toolName?: string;
  marker?: string;
  headRatio?: number;
}>;

export function truncateInlineText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = `...[truncated ${text.length - maxChars} chars]`;
  if (suffix.length >= maxChars) {
    return suffix.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

function buildTruncationSignal(args: {
  marker: string;
  toolName?: string;
  originalChars: number;
  limitChars: number;
  omittedChars: number;
}): string {
  const toolPart = args.toolName ? ` tool=${args.toolName}` : '';
  return `\n...[${args.marker}${toolPart} original_chars=${args.originalChars} limit_chars=${args.limitChars} omitted_chars=${args.omittedChars}]...\n`;
}

export function truncateToolOutputText(
  text: string,
  options: ToolOutputTruncationOptions = {},
): ToolOutputTruncationResult {
  const limitChars =
    typeof options.limitChars === 'number' &&
    Number.isInteger(options.limitChars) &&
    options.limitChars > 0
      ? options.limitChars
      : DEFAULT_TOOL_OUTPUT_CHAR_LIMIT;
  const marker =
    typeof options.marker === 'string' && options.marker.trim() !== ''
      ? options.marker.trim()
      : 'tool_output_truncated_in_tool';
  const headRatio =
    typeof options.headRatio === 'number' && options.headRatio > 0 && options.headRatio < 1
      ? options.headRatio
      : 0.67;

  if (text.length <= limitChars) {
    return {
      text,
      truncated: false,
      originalChars: text.length,
      omittedChars: 0,
      limitChars,
    };
  }

  let omittedChars = 0;
  let signal = buildTruncationSignal({
    marker,
    toolName: options.toolName,
    originalChars: text.length,
    limitChars,
    omittedChars,
  });
  if (signal.length >= limitChars) {
    return {
      text: signal.slice(0, limitChars),
      truncated: true,
      originalChars: text.length,
      omittedChars: text.length,
      limitChars,
    };
  }

  const bodyBudget = limitChars - signal.length;
  let headChars = Math.ceil(bodyBudget * headRatio);
  let tailChars = bodyBudget - headChars;
  omittedChars = Math.max(0, text.length - headChars - tailChars);
  signal = buildTruncationSignal({
    marker,
    toolName: options.toolName,
    originalChars: text.length,
    limitChars,
    omittedChars,
  });

  while (signal.length > limitChars - headChars - tailChars && (headChars > 0 || tailChars > 0)) {
    if (headChars >= tailChars && headChars > 0) {
      headChars--;
    } else if (tailChars > 0) {
      tailChars--;
    } else {
      break;
    }
    omittedChars = Math.max(0, text.length - headChars - tailChars);
    signal = buildTruncationSignal({
      marker,
      toolName: options.toolName,
      originalChars: text.length,
      limitChars,
      omittedChars,
    });
  }

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
  return {
    text: `${head}${signal}${tail}`,
    truncated: true,
    originalChars: text.length,
    omittedChars,
    limitChars,
  };
}
