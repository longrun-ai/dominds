export type SetupRequirement =
  | { kind: 'ok' }
  | { kind: 'missing_team_yaml'; teamYamlPath: string }
  | { kind: 'invalid_team_yaml'; teamYamlPath: string; errorText: string }
  | {
      kind: 'missing_member_defaults_fields';
      teamYamlPath: string;
      missing: Array<'provider' | 'model'>;
    }
  | { kind: 'unknown_provider'; provider: string }
  | { kind: 'unknown_model'; provider: string; model: string }
  | { kind: 'missing_provider_env'; provider: string; envVar: string };

export type SetupShellInfo = {
  env: string | null;
  kind: 'bash' | 'zsh' | 'other';
  defaultRc: 'bashrc' | 'zshrc' | 'unknown';
};

export type SetupRcFileInfo = {
  path: string;
  exists: boolean;
  writable: boolean;
};

export type SetupTeamYamlInfo = {
  path: string;
  exists: boolean;
  parseError?: string;
  memberDefaults?: { provider?: string; model?: string };
};

export type SetupWorkspaceLlmYamlInfo = {
  path: string;
  exists: boolean;
  parseError?: string;
  providerKeys?: string[];
};

export type SetupProviderModelSummary = {
  key: string;
  name?: string;
  contextWindow?: string;
  contextLength?: number;
  inputLength?: number;
  outputLength?: number;
  // "Verified" here means the provider env var is present (config is runnable).
  verified: boolean;
};

export type SetupProviderSummary = {
  providerKey: string;
  name: string;
  apiType: 'codex' | 'anthropic' | 'mock' | 'openai';
  baseUrl: string;
  apiKeyEnvVar: string;
  techSpecUrl?: string;
  apiMgmtUrl?: string;
  envVar: { isSet: boolean; bashrcHas: boolean; zshrcHas: boolean };
  models: SetupProviderModelSummary[];
};

export type SetupStatusResponse =
  | {
      success: true;
      requirement: SetupRequirement;
      shell: SetupShellInfo;
      rc: { bashrc: SetupRcFileInfo; zshrc: SetupRcFileInfo };
      teamYaml: SetupTeamYamlInfo;
      workspaceLlmYaml: SetupWorkspaceLlmYamlInfo;
      providers: SetupProviderSummary[];
    }
  | {
      success: false;
      requirement: SetupRequirement;
      shell: SetupShellInfo;
      rc: { bashrc: SetupRcFileInfo; zshrc: SetupRcFileInfo };
      teamYaml: SetupTeamYamlInfo;
      workspaceLlmYaml: SetupWorkspaceLlmYamlInfo;
      providers: SetupProviderSummary[];
      error: string;
    };

export type SetupWriteShellEnvRequest = {
  envVar: string;
  value: string;
  targets: Array<'bashrc' | 'zshrc'>;
};

export type SetupWriteShellEnvOutcome = {
  target: 'bashrc' | 'zshrc';
  path: string;
  result: 'created' | 'updated';
};

export type SetupWriteShellEnvResponse =
  | { success: true; outcomes: SetupWriteShellEnvOutcome[] }
  | { success: false; error: string };

export type SetupFileKind = 'defaults_yaml' | 'workspace_llm_yaml';

export type SetupFileResponse =
  | { success: true; kind: SetupFileKind; path: string; raw: string }
  | { success: false; kind: SetupFileKind; path: string; error: string };

export type SetupWriteTeamYamlRequest = {
  provider: string;
  model: string;
  overwrite: boolean;
};

export type SetupWriteTeamYamlResponse =
  | { success: true; path: string; action: 'created' | 'overwritten' }
  | { success: false; path: string; error: string };
