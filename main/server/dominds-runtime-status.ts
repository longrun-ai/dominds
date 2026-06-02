import type {
  DomindsRuntimeMode,
  DomindsRuntimeStatus,
  DomindsRuntimeStatusMessage,
} from '@longrun-ai/kernel/types';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../log';
import { DOMINDS_RUNNING_VERSION } from './dominds-running-version';
import { getDomindsSelfUpdateStatus } from './dominds-self-update';

const log = createLogger('dominds-runtime-status');

function resolveDomindsInstallRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

async function readSpaHash(): Promise<string | null> {
  const indexPath = path.join(resolveDomindsInstallRoot(), 'webapp', 'dist', 'index.html');
  try {
    const indexHtml = await fs.readFile(indexPath, 'utf8');
    return createHash('sha256').update(indexHtml).digest('hex');
  } catch (error) {
    log.warn('Failed to read SPA hash from dist index.html', error, { indexPath });
    return null;
  }
}

export async function getDomindsRuntimeStatus(
  mode: DomindsRuntimeMode,
): Promise<DomindsRuntimeStatus> {
  return {
    workspace: process.cwd(),
    version: DOMINDS_RUNNING_VERSION,
    spaHash: await readSpaHash(),
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
