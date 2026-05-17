import type {
  DialogNextStepTriggerState,
  DialogTellaskCallState,
  DialogTellaskResultState,
} from '@longrun-ai/kernel/types/storage';

export function createEmptyDialogNextStepState(): DialogNextStepTriggerState {
  return { nextSeq: 1, triggers: [] };
}

export function createEmptyDialogTellaskCallState(): DialogTellaskCallState {
  return { calls: [] };
}

export function createEmptyDialogTellaskResultState(): DialogTellaskResultState {
  return { results: [] };
}
