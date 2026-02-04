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

export type SetupRtwsLlmYamlInfo = {
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

export type SetupProminentModelParamNamespace = 'general' | 'codex' | 'openai' | 'anthropic';

export type SetupProminentEnumModelParam = {
  namespace: SetupProminentModelParamNamespace;
  key: string;
  description: string;
  values: string[];
  defaultValue?: string;
};

export type SetupProviderSummary = {
  providerKey: string;
  name: string;
  apiType: 'codex' | 'anthropic' | 'mock' | 'openai' | 'openai-compatible';
  baseUrl: string;
  apiKeyEnvVar: string;
  techSpecUrl?: string;
  apiMgmtUrl?: string;
  envVar: { isSet: boolean; bashrcHas: boolean; zshrcHas: boolean };
  models: SetupProviderModelSummary[];
  prominentModelParams?: SetupProminentEnumModelParam[];
};

export type SetupStatusResponse =
  | {
      success: true;
      requirement: SetupRequirement;
      shell: SetupShellInfo;
      rc: { bashrc: SetupRcFileInfo; zshrc: SetupRcFileInfo };
      teamYaml: SetupTeamYamlInfo;
      rtwsLlmYaml: SetupRtwsLlmYamlInfo;
      providers: SetupProviderSummary[];
    }
  | {
      success: false;
      requirement: SetupRequirement;
      shell: SetupShellInfo;
      rc: { bashrc: SetupRcFileInfo; zshrc: SetupRcFileInfo };
      teamYaml: SetupTeamYamlInfo;
      rtwsLlmYaml: SetupRtwsLlmYamlInfo;
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

export type SetupFileKind = 'defaults_yaml' | 'rtws_llm_yaml';

export type SetupFileResponse =
  | { success: true; kind: SetupFileKind; path: string; raw: string }
  | { success: false; kind: SetupFileKind; path: string; error: string };

export type SetupWriteTeamYamlRequest = {
  provider: string;
  model: string;
  overwrite: boolean;
  // Written to `.minds/team.yaml` at `member_defaults.model_params.<namespace>.*`.
  // For bootstrap: prefer explicitly setting params marked as `prominent: true` in defaults.
  modelParams?: Partial<Record<SetupProminentModelParamNamespace, Record<string, string>>>;
};

export type SetupWriteTeamYamlResponse =
  | { success: true; path: string; action: 'created' | 'overwritten' }
  | { success: false; path: string; error: string };

export type SetupWriteRtwsLlmYamlRequest = {
  raw: string;
  overwrite: boolean;
};

export type SetupWriteRtwsLlmYamlResponse =
  | { success: true; path: string; action: 'created' | 'overwritten' }
  | { success: false; path: string; error: string };
