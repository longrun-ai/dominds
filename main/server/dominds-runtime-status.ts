import type {
  DomindsRuntimeMode,
  DomindsRuntimeStatus,
  DomindsRuntimeStatusMessage,
} from '@longrun-ai/kernel/types';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DOMINDS_RUNNING_VERSION } from './dominds-running-version';
import { getDomindsSelfUpdateStatus } from './dominds-self-update';

export async function getDomindsRuntimeStatus(
  mode: DomindsRuntimeMode,
): Promise<DomindsRuntimeStatus> {
  return {
    workspace: process.cwd(),
    version: DOMINDS_RUNNING_VERSION,
    mode,
    selfUpdate: await getDomindsSelfUpdateStatus(),
  };
}

export async function createDomindsRuntimeStatusMessage(
  mode: DomindsRuntimeMode,
): Promise<DomindsRuntimeStatusMessage> {
  return {
    type: 'dominds_runtime_status',
    runtimeStatus: await getDomindsRuntimeStatus(mode),
    timestamp: formatUnifiedTimestamp(new Date()),
  };
}
