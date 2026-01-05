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
  extra?: string[];
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
  return inspect(value, { depth: 5, breakLength: 120, compact: false, sorted: true });
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
    const maybeError = error as { name?: string; message?: string; stack?: string };
    const messageValue = maybeError.message;
    return {
      name: typeof maybeError.name === 'string' ? maybeError.name : undefined,
      message:
        typeof messageValue === 'string'
          ? messageValue
          : messageValue === undefined
            ? 'Error object has undefined message property'
            : `Error object has non-string message property of type '${typeof messageValue}'`,
      stack: typeof maybeError.stack === 'string' ? maybeError.stack : undefined,
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
    const extraEntries: string[] = extraData.map((value) => inspectValue(value));

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

    if (extraEntries.length > 0) {
      record.extra = extraEntries;
    }

    return record;
  }

  private formatLine(record: LogRecord): string {
    let errorText = '';
    if (record.error) {
      const { name, message, stack } = record.error;
      if (stack) {
        // When an error object is passed, show only the stack trace to avoid duplication
        // The log message should already contain the error description
        errorText = `\n${stack}`;
      } else if (message) {
        // Fallback for error objects without stack
        if (name && message !== name) {
          errorText = ` Error: ${name}: ${message}`;
        } else {
          errorText = ` Error: ${message}`;
        }
      } else {
        // Fallback to inspect for complex error objects
        errorText = ` Error: ${inspectValue(record.error)}`;
      }
    }

    const extraText =
      record.extra && record.extra.length > 0
        ? ` Extra: ${record.extra.map((entry) => inspectValue(entry)).join('; ')}`
        : '';
    if (record.location) {
      const prefix = `[${record.timestamp}] ${record.tag ? `[${record.tag}] ` : ''}${record.level.toUpperCase()}\n  @ ${stripPkgPrefix(record.location.file)}:${record.location.line}:${record.location.column}`;
      return `${prefix}\n${record.message}${errorText}${extraText}`;
    } else {
      const prefix = `[${record.timestamp}] ${record.tag ? `[${record.tag}] ` : ''}${record.level.toUpperCase()}:`;
      return `${prefix} ${record.message}${errorText}${extraText}`;
    }
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
