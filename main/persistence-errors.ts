export type DomindsPersistenceFileSource =
  | 'dialog_state'
  | 'dialog_latest'
  | 'dialog_metadata'
  | 'dialog_asker_stack'
  | 'dialog_course_events'
  | 'reminder_state'
  | 'questions4human_state'
  | 'pending_sideDialogs'
  | 'sideDialog_responses'
  | 'sideDialog_registry';

export type DomindsPersistenceFileOperation = 'read' | 'parse';

export type DomindsPersistenceFileFormat = 'yaml' | 'json' | 'jsonl';

type DomindsPersistenceFileErrorArgs = {
  message: string;
  source: DomindsPersistenceFileSource;
  operation: DomindsPersistenceFileOperation;
  format: DomindsPersistenceFileFormat;
  filePath: string;
  eofLike: boolean;
  lineNumber?: number;
  cause?: unknown;
};

export class DomindsPersistenceFileError extends Error {
  public readonly code = 'DOMINDS_PERSISTENCE_FILE_ERROR';
  public readonly source: DomindsPersistenceFileSource;
  public readonly operation: DomindsPersistenceFileOperation;
  public readonly format: DomindsPersistenceFileFormat;
  public readonly filePath: string;
  public readonly eofLike: boolean;
  public readonly lineNumber?: number;
  public readonly cause?: unknown;

  constructor(args: DomindsPersistenceFileErrorArgs) {
    super(args.message);
    this.name = 'DomindsPersistenceFileError';
    this.source = args.source;
    this.operation = args.operation;
    this.format = args.format;
    this.filePath = args.filePath;
    this.eofLike = args.eofLike;
    this.lineNumber = args.lineNumber;
    this.cause = args.cause;
  }
}

function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function readNestedError(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  ) {
    return value.error;
  }
  return undefined;
}

function readCause(value: unknown): unknown {
  if (value instanceof Error) {
    const withCause = value as Error & { cause?: unknown };
    return withCause.cause;
  }
  if (typeof value === 'object' && value !== null && 'cause' in value) {
    return value.cause;
  }
  return undefined;
}

export function findDomindsPersistenceFileError(
  error: unknown,
): DomindsPersistenceFileError | undefined {
  const queue: unknown[] = [error];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current instanceof DomindsPersistenceFileError) {
      return current;
    }
    if (!isObjectLike(current)) {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const nestedError = readNestedError(current);
    if (nestedError !== undefined) {
      queue.push(nestedError);
    }
    const cause = readCause(current);
    if (cause !== undefined) {
      queue.push(cause);
    }
  }

  return undefined;
}
