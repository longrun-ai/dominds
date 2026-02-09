/**
 * Module: log
 *
 * Lightweight structured logger with levels and tags.
 * - `Logger` formats records and prints to console
 * - `log` default instance and `createLogger(tag)` helper
 */
import { inspect } from 'util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  tag?: string;
  location?: {
    file: string;
    line?: number;
    column?: number;
  };
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
  extra?: unknown[];
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_LOG_LINE_CHARS = 3 * 1024;
const DETAIL_FALLBACK_BUDGET_CHARS = 512;
const DETAIL_MIN_BUDGET_CHARS = 48;

type DetailInspectProfile = Readonly<{
  maxDepth: number;
  maxObjectKeys: number;
  maxArrayItems: number;
  maxMapEntries: number;
  maxSetEntries: number;
  maxStringLength: number;
}>;

const DETAIL_INSPECT_PROFILES: ReadonlyArray<DetailInspectProfile> = [
  {
    maxDepth: 6,
    maxObjectKeys: 120,
    maxArrayItems: 160,
    maxMapEntries: 80,
    maxSetEntries: 80,
    maxStringLength: 2048,
  },
  {
    maxDepth: 5,
    maxObjectKeys: 80,
    maxArrayItems: 100,
    maxMapEntries: 40,
    maxSetEntries: 40,
    maxStringLength: 1536,
  },
  {
    maxDepth: 4,
    maxObjectKeys: 50,
    maxArrayItems: 60,
    maxMapEntries: 24,
    maxSetEntries: 24,
    maxStringLength: 1024,
  },
  {
    maxDepth: 3,
    maxObjectKeys: 24,
    maxArrayItems: 30,
    maxMapEntries: 12,
    maxSetEntries: 12,
    maxStringLength: 768,
  },
  {
    maxDepth: 2,
    maxObjectKeys: 12,
    maxArrayItems: 12,
    maxMapEntries: 8,
    maxSetEntries: 8,
    maxStringLength: 512,
  },
  {
    maxDepth: 1,
    maxObjectKeys: 6,
    maxArrayItems: 6,
    maxMapEntries: 4,
    maxSetEntries: 4,
    maxStringLength: 320,
  },
  {
    maxDepth: 0,
    maxObjectKeys: 3,
    maxArrayItems: 3,
    maxMapEntries: 2,
    maxSetEntries: 2,
    maxStringLength: 192,
  },
];

type TruncateResult = Readonly<{
  text: string;
  truncated: boolean;
}>;

type PruneResult = Readonly<{
  value: unknown;
  pruned: boolean;
}>;

function truncateText(value: string, maxChars: number, suffix?: string): TruncateResult {
  if (maxChars <= 0) {
    return { text: '', truncated: value.length > 0 };
  }
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }

  const rawSuffix =
    typeof suffix === 'string' && suffix.trim() !== ''
      ? suffix
      : `...[truncated ${value.length - maxChars} chars]`;
  if (rawSuffix.length >= maxChars) {
    return { text: rawSuffix.slice(0, maxChars), truncated: true };
  }
  const keepLen = maxChars - rawSuffix.length;
  return {
    text: `${value.slice(0, keepLen)}${rawSuffix}`,
    truncated: true,
  };
}

function appendSignalWithinBudget(value: string, signal: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (signal.length >= maxChars) return signal.slice(0, maxChars);
  if (value.length + signal.length <= maxChars) return `${value}${signal}`;
  const keepLen = maxChars - signal.length;
  return `${value.slice(0, keepLen)}${signal}`;
}

function getConstructorName(value: object): string {
  const candidate = (value as { constructor?: unknown }).constructor;
  if (typeof candidate === 'function') {
    const named = candidate as { name?: unknown };
    if (typeof named.name === 'string' && named.name.trim() !== '') {
      return named.name;
    }
  }
  return 'Object';
}

function isDateLike(value: unknown): value is Date {
  return value instanceof Date;
}

function isRegExpLike(value: unknown): value is RegExp {
  return value instanceof RegExp;
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error;
}

function pruneForLog(
  value: unknown,
  profile: DetailInspectProfile,
  depth: number,
  seen: WeakSet<object>,
): PruneResult {
  if (typeof value === 'string') {
    const truncated = truncateText(value, profile.maxStringLength);
    return { value: truncated.text, pruned: truncated.truncated };
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return { value, pruned: false };
  }
  if (typeof value === 'function') {
    const fnName = value.name && value.name.trim() !== '' ? value.name : 'anonymous';
    return { value: `[Function ${fnName}]`, pruned: false };
  }

  if (isDateLike(value) || isRegExpLike(value)) {
    return { value, pruned: false };
  }

  if (isErrorLike(value)) {
    const name = typeof value.name === 'string' ? value.name : 'Error';
    const msg = typeof value.message === 'string' ? value.message : '';
    const stack = typeof value.stack === 'string' ? value.stack : '';
    const msgShort = truncateText(msg, profile.maxStringLength);
    const stackShort = truncateText(stack, profile.maxStringLength);
    const reduced: Record<string, unknown> = {
      name,
      message: msgShort.text,
    };
    if (stackShort.text.trim() !== '') {
      reduced.stack = stackShort.text;
    }
    return { value: reduced, pruned: msgShort.truncated || stackShort.truncated };
  }

  if (typeof value !== 'object') {
    return { value, pruned: false };
  }

  if (seen.has(value)) {
    return { value: '[Circular]', pruned: true };
  }

  if (depth >= profile.maxDepth) {
    const ctorName = getConstructorName(value);
    return { value: `[${ctorName} depth limit reached]`, pruned: true };
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      let pruned = false;
      const limit = Math.max(0, profile.maxArrayItems);
      const visibleCount = Math.min(value.length, limit);
      for (let i = 0; i < visibleCount; i++) {
        const child = pruneForLog(value[i], profile, depth + 1, seen);
        out.push(child.value);
        pruned = pruned || child.pruned;
      }
      if (value.length > visibleCount) {
        out.push(`[+${value.length - visibleCount} more item(s)]`);
        pruned = true;
      }
      return { value: out, pruned };
    }

    if (value instanceof Map) {
      const entries: unknown[] = [];
      let pruned = false;
      let index = 0;
      for (const [mapKey, mapValue] of value.entries()) {
        if (index >= profile.maxMapEntries) {
          break;
        }
        const keyPruned = pruneForLog(mapKey, profile, depth + 1, seen);
        const valuePruned = pruneForLog(mapValue, profile, depth + 1, seen);
        entries.push([keyPruned.value, valuePruned.value]);
        pruned = pruned || keyPruned.pruned || valuePruned.pruned;
        index++;
      }
      const reduced: Record<string, unknown> = {
        __type__: 'Map',
        size: value.size,
        entries,
      };
      if (value.size > entries.length) {
        reduced.__omittedEntries__ = value.size - entries.length;
        pruned = true;
      }
      return { value: reduced, pruned };
    }

    if (value instanceof Set) {
      const entries: unknown[] = [];
      let pruned = false;
      let index = 0;
      for (const setValue of value.values()) {
        if (index >= profile.maxSetEntries) {
          break;
        }
        const valuePruned = pruneForLog(setValue, profile, depth + 1, seen);
        entries.push(valuePruned.value);
        pruned = pruned || valuePruned.pruned;
        index++;
      }
      const reduced: Record<string, unknown> = {
        __type__: 'Set',
        size: value.size,
        values: entries,
      };
      if (value.size > entries.length) {
        reduced.__omittedEntries__ = value.size - entries.length;
        pruned = true;
      }
      return { value: reduced, pruned };
    }

    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      if (value instanceof ArrayBuffer) {
        return { value: `[ArrayBuffer byteLength=${value.byteLength}]`, pruned: true };
      }
      const typed = value as ArrayBufferView;
      const byteLen = typeof typed.byteLength === 'number' ? typed.byteLength : 0;
      const ctorName = getConstructorName(value);
      return { value: `[${ctorName} byteLength=${byteLen}]`, pruned: true };
    }

    const source = value as Record<string, unknown>;
    const allKeys = Object.keys(source).sort();
    const visibleKeys = allKeys.slice(0, profile.maxObjectKeys);
    const ctorName = getConstructorName(value);
    const reduced: Record<string, unknown> = {};
    let pruned = false;
    if (ctorName !== 'Object') {
      reduced.__class__ = ctorName;
    }
    for (const key of visibleKeys) {
      const child = pruneForLog(source[key], profile, depth + 1, seen);
      reduced[key] = child.value;
      pruned = pruned || child.pruned;
    }
    if (allKeys.length > visibleKeys.length) {
      reduced.__omittedKeys__ = allKeys.length - visibleKeys.length;
      pruned = true;
    }
    return { value: reduced, pruned };
  } finally {
    seen.delete(value);
  }
}

type DetailRenderResult = Readonly<{
  text: string;
  truncated: boolean;
}>;

function inspectAdaptive(value: unknown, maxChars: number): DetailRenderResult {
  if (maxChars <= 0) {
    return { text: '', truncated: true };
  }
  if (typeof value === 'string') {
    return truncateText(value, maxChars);
  }

  let fallback = '';
  for (let idx = 0; idx < DETAIL_INSPECT_PROFILES.length; idx++) {
    const profile = DETAIL_INSPECT_PROFILES[idx];
    const pruned = pruneForLog(value, profile, 0, new WeakSet<object>());
    const rendered = inspect(pruned.value, {
      depth: null,
      breakLength: 120,
      compact: false,
      sorted: true,
      maxArrayLength: profile.maxArrayItems,
      maxStringLength: profile.maxStringLength,
    });
    const reducedByProfile = idx > 0 || pruned.pruned;
    const signal = reducedByProfile
      ? ` [details_reduced depth<=${profile.maxDepth}, keys<=${profile.maxObjectKeys}, items<=${profile.maxArrayItems}]`
      : '';
    if (signal === '') {
      if (rendered.length <= maxChars) {
        return { text: rendered, truncated: false };
      }
      fallback = rendered;
      continue;
    }
    const signaledLen = rendered.length + signal.length;
    if (signaledLen <= maxChars) {
      return { text: `${rendered}${signal}`, truncated: true };
    }
    fallback = `${rendered}${signal}`;
  }

  const hard = truncateText(
    fallback,
    maxChars,
    `...[details_truncated >${maxChars} chars after adaptive inspect]`,
  );
  return { text: hard.text, truncated: true };
}

function resolveDefaultLevel(): LogLevel {
  const envLevel = (process.env.DOMINDS_LOG_LEVEL || '').toLowerCase();
  if (envLevel && (envLevel as LogLevel) in levelPriority) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === 'dev' ? 'debug' : 'info';
}

function nowTsStr(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}/${month}/${day}-${hour}:${minute}:${second}`;
}

function inspectValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return inspectAdaptive(value, DETAIL_FALLBACK_BUDGET_CHARS).text;
}

export function extractErrorDetails(error: Error | unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (!error)
    return {
      message: `Strange error type='${typeof error}'`,
    };
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === 'object' && error !== null) {
    const maybeError = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    const hasMessageProp = Object.prototype.hasOwnProperty.call(maybeError, 'message');
    const messageValue = hasMessageProp ? maybeError.message : undefined;
    const name = typeof maybeError.name === 'string' ? maybeError.name : undefined;
    const stack = typeof maybeError.stack === 'string' ? maybeError.stack : undefined;
    const resolvedMessage =
      typeof messageValue === 'string'
        ? messageValue
        : hasMessageProp && messageValue !== undefined
          ? inspectValue(messageValue)
          : inspectValue(error);
    return {
      name,
      message: resolvedMessage,
      stack,
    };
  }
  return {
    message: inspectValue(error),
  };
}

function getCallerLocation(
  skipFrames: number = 0,
): { file: string; line?: number; column?: number } | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split('\n');
  // Skip the first few lines which are the error creation and our own logger methods
  // skipFrames allows precise caller identification for different logger methods
  for (let i = 3 + skipFrames; i < Math.min(lines.length, skipFrames + 10); i++) {
    const line = lines[i];
    const match = line.match(/at\s+(?:.*\s+)?\(?(.+?):(\d+):(\d+)\)?/);
    if (match) {
      const [, file, lineNum, column] = match;
      // Skip internal Node.js, logger files, and utility functions
      const skipPatterns = ['node:', 'inspect', 'formatLine', 'extractErrorDetails'];
      const shouldSkip = skipPatterns.some((pattern) => file.includes(pattern));

      if (!shouldSkip) {
        return {
          file: file,
          line: parseInt(lineNum, 10),
          column: parseInt(column, 10),
        };
      }
    }
  }
}

const pkgFilePathPrefix: string | undefined = (() => {
  const loc = getCallerLocation(0);
  if (loc?.file) {
    for (const thisModuPart of ['/src/log.', '/log.']) {
      const thisModuIdx = loc.file.lastIndexOf(thisModuPart);
      if (thisModuIdx > 0) {
        return loc.file.substring(0, thisModuIdx);
      }
    }
  }
})();

function stripPkgPrefix(file: string): string {
  if (pkgFilePathPrefix && file.startsWith(pkgFilePathPrefix)) {
    return file.substring(pkgFilePathPrefix.length + 1); // +1 to remove the leading slash
  }
  return file;
}

/**
 * Logger
 *
 * Structured console logger with level gating, tagging, and rich error/extra formatting.
 * Levels: debug, info, warn, error.
 */
export class Logger {
  private level: LogLevel;
  private tag?: string;

  constructor(tag?: string, level: LogLevel = resolveDefaultLevel()) {
    this.tag = tag;
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return levelPriority[level] >= levelPriority[this.level];
  }

  private formatRecord(
    level: LogLevel,
    message: string,
    error?: Error | unknown,
    extraData: unknown[] = [],
  ): LogRecord {
    const timestamp = nowTsStr();

    const record: LogRecord = {
      timestamp,
      level,
      message,
    };

    if (this.tag) {
      record.tag = this.tag;
    }

    // Include location info for debug level
    if (this.level === 'debug') {
      record.location = getCallerLocation(2);
    }

    if (error !== undefined && error !== null) {
      record.error = extractErrorDetails(error);
    }

    if (extraData.length > 0) {
      record.extra = [...extraData];
    }

    return record;
  }

  private formatErrorText(
    error: NonNullable<LogRecord['error']>,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    if (maxChars <= 0) {
      return { text: '', truncated: true };
    }
    if (error.stack) {
      if (maxChars <= 1) {
        return { text: '\n'.slice(0, maxChars), truncated: true };
      }
      const rendered = inspectAdaptive(error.stack, maxChars - 1);
      return {
        text: `\n${rendered.text}`,
        truncated: rendered.truncated,
      };
    }

    if (error.message) {
      const head = ' Error: ';
      if (maxChars <= head.length) {
        return { text: truncateText(head, maxChars).text, truncated: true };
      }
      const plain =
        error.name && error.message !== error.name
          ? `${error.name}: ${error.message}`
          : error.message;
      const rendered = inspectAdaptive(plain, maxChars - head.length);
      return {
        text: `${head}${rendered.text}`,
        truncated: rendered.truncated,
      };
    }

    const head = ' Error: ';
    if (maxChars <= head.length) {
      return { text: truncateText(head, maxChars).text, truncated: true };
    }
    const rendered = inspectAdaptive(error, maxChars - head.length);
    return {
      text: `${head}${rendered.text}`,
      truncated: rendered.truncated,
    };
  }

  private formatExtraText(extra: ReadonlyArray<unknown>, maxChars: number): string {
    if (maxChars <= 0) {
      return '';
    }
    const head = ' Extra: ';
    if (maxChars <= head.length) {
      return truncateText(head, maxChars).text;
    }

    let remaining = maxChars - head.length;
    let renderedEntries = '';
    let usedCount = 0;
    let reduced = false;

    for (let i = 0; i < extra.length; i++) {
      const separator = i === 0 ? '' : '; ';
      if (remaining <= separator.length + 1) {
        reduced = true;
        break;
      }
      const entriesLeft = extra.length - i;
      const softBudget = Math.max(
        DETAIL_MIN_BUDGET_CHARS,
        Math.floor((remaining - separator.length) / entriesLeft),
      );
      const entryBudget = Math.max(1, Math.min(remaining - separator.length, softBudget));
      const rendered = inspectAdaptive(extra[i], entryBudget);
      renderedEntries += `${separator}${rendered.text}`;
      remaining -= separator.length + rendered.text.length;
      usedCount++;
      reduced = reduced || rendered.truncated;
    }

    if (usedCount < extra.length) {
      reduced = true;
    }
    if (reduced) {
      const omittedItems = Math.max(0, extra.length - usedCount);
      const signal =
        omittedItems > 0 ? ` [extra_truncated omitted_items=${omittedItems}]` : ' [extra_reduced]';
      renderedEntries = appendSignalWithinBudget(renderedEntries, signal, maxChars - head.length);
    }
    return `${head}${renderedEntries}`;
  }

  private formatLine(record: LogRecord): string {
    let contentPrefix = '';
    if (record.location) {
      contentPrefix = `[${record.timestamp}] ${record.tag ? `[${record.tag}] ` : ''}${record.level.toUpperCase()}\n  @ ${stripPkgPrefix(record.location.file)}:${record.location.line}:${record.location.column}\n${record.message}`;
    } else {
      contentPrefix = `[${record.timestamp}] ${record.tag ? `[${record.tag}] ` : ''}${record.level.toUpperCase()}: ${record.message}`;
    }

    let line = contentPrefix;
    if (record.error) {
      const maxForError = Math.max(0, MAX_LOG_LINE_CHARS - line.length);
      const renderedError = this.formatErrorText(record.error, maxForError);
      line += renderedError.text;
    }
    if (record.extra && record.extra.length > 0) {
      const maxForExtra = Math.max(0, MAX_LOG_LINE_CHARS - line.length);
      line += this.formatExtraText(record.extra, maxForExtra);
    }
    if (line.length > MAX_LOG_LINE_CHARS) {
      return appendSignalWithinBudget(
        line,
        `...[log_line_truncated limit=${MAX_LOG_LINE_CHARS}]`,
        MAX_LOG_LINE_CHARS,
      );
    }
    return line;
  }

  private log(
    level: LogLevel,
    message: string,
    error?: Error | unknown,
    ...extraData: unknown[]
  ): void {
    if (!this.shouldLog(level)) return;
    const record = this.formatRecord(level, message, error, extraData);
    const line = this.formatLine(record);
    switch (level) {
      case 'debug':
        console.debug(line);
        break;
      case 'info':
        console.info(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
      default:
        console.log(line);
        break;
    }
  }

  debug(message: string, error?: Error | unknown, ...extraData: unknown[]): void {
    this.log('debug', message, error, ...extraData);
  }

  info(message: string, error?: Error | unknown, ...extraData: unknown[]): void {
    this.log('info', message, error, ...extraData);
  }

  warn(message: string, error?: Error | unknown, ...extraData: unknown[]): void {
    this.log('warn', message, error, ...extraData);
  }

  error(message: string, error?: Error | unknown, ...extraData: unknown[]): void {
    this.log('error', message, error, ...extraData);
  }
}

export const log = new Logger();
export function createLogger(tag: string): Logger {
  return new Logger(tag);
}
