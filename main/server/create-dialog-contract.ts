import type {
  CreateDialogErrorCode,
  CreateDialogInput,
  CreateDialogResult,
} from '../shared/types/wire';
import { isTaskPackagePath } from '../utils/task-package';

export type CreateDialogParseFailure = {
  requestId: string;
  status: 400;
  errorCode: CreateDialogErrorCode;
  error: string;
};

export function parseCreateDialogInput(
  parsed: Record<string, unknown>,
): CreateDialogInput | CreateDialogParseFailure {
  const requestId = typeof parsed['requestId'] === 'string' ? parsed['requestId'].trim() : '';
  if (!requestId) {
    return {
      requestId: 'unknown',
      status: 400,
      errorCode: 'CREATE_FAILED',
      error: 'requestId is required',
    };
  }

  const agentId = typeof parsed['agentId'] === 'string' ? parsed['agentId'].trim() : '';
  if (!agentId) {
    return {
      requestId,
      status: 400,
      errorCode: 'TEAM_MEMBER_INVALID',
      error: 'agentId is required',
    };
  }

  const taskDocPath = typeof parsed['taskDocPath'] === 'string' ? parsed['taskDocPath'].trim() : '';
  if (!taskDocPath) {
    return {
      requestId,
      status: 400,
      errorCode: 'TASKDOC_INVALID',
      error: 'taskDocPath is required',
    };
  }
  if (!isTaskPackagePath(taskDocPath)) {
    return {
      requestId,
      status: 400,
      errorCode: 'TASKDOC_INVALID',
      error: `taskDocPath must be a Taskdoc directory ending in '.tsk' (got: '${taskDocPath}')`,
    };
  }

  const primingModeRaw = parsed['agentPrimingMode'];
  if (primingModeRaw !== 'do' && primingModeRaw !== 'reuse' && primingModeRaw !== 'skip') {
    return {
      requestId,
      status: 400,
      errorCode: 'CREATE_FAILED',
      error: "agentPrimingMode must be one of 'do' | 'reuse' | 'skip'",
    };
  }

  return {
    requestId,
    agentId,
    taskDocPath,
    agentPrimingMode: primingModeRaw,
  };
}

export function makeCreateDialogFailure(
  requestId: string,
  errorCode: CreateDialogErrorCode,
  error: string,
): Extract<CreateDialogResult, { kind: 'failure' }> {
  return {
    kind: 'failure',
    requestId,
    errorCode,
    error,
  };
}

export function normalizeCreateDialogErrorCode(raw: unknown): CreateDialogErrorCode {
  switch (raw) {
    case 'TEAM_NOT_READY':
    case 'TEAM_MEMBER_INVALID':
    case 'TASKDOC_INVALID':
    case 'AUTH_REQUIRED':
    case 'CREATE_FAILED':
      return raw;
    default:
      return 'CREATE_FAILED';
  }
}
