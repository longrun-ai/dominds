export const DOMINDS_SUPERVISOR_RESTART_WEBUI = 'dominds.supervisor.restart_webui.v1';

export type DomindsSupervisorRestartStrategy = 'current_entrypoint' | 'npx_latest';

export type DomindsSupervisorRestartWebuiMessage = Readonly<{
  type: typeof DOMINDS_SUPERVISOR_RESTART_WEBUI;
  cwd: string;
  host: string;
  port: number;
  traceFile: string;
  debugDir: string;
  currentVersion: string;
  targetVersion: string | null;
  restartStrategy: DomindsSupervisorRestartStrategy;
}>;

export type DomindsRunnerToSupervisorMessage = DomindsSupervisorRestartWebuiMessage;
