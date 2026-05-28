import type { DomindsSelfUpdateRunKind } from '@longrun-ai/kernel/types';

export const DOMINDS_SUPERVISOR_RESTART_WEBUI = 'dominds.supervisor.restart_webui.v1';

export type DomindsSupervisorRestartRunKind = Extract<DomindsSelfUpdateRunKind, 'global' | 'npx'>;

export type DomindsSupervisorRestartWebuiMessage = Readonly<{
  type: typeof DOMINDS_SUPERVISOR_RESTART_WEBUI;
  cwd: string;
  host: string;
  port: number;
  traceFile: string;
  debugDir: string;
  currentVersion: string;
  targetVersion: string | null;
  runKind: DomindsSupervisorRestartRunKind;
}>;

export type DomindsRunnerToSupervisorMessage = DomindsSupervisorRestartWebuiMessage;
