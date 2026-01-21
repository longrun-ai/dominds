/**
 * Module: team
 *
 * Team configuration and member modeling:
 * - `Team` aggregating members and defaults
 * - YAML load/conversion helpers
 * - `Team.Member` with tool resolution and access fields
 */
import fs from 'fs/promises';
import YAML from 'yaml';

import { LlmConfig } from './llm/client';
import { log } from './log';
import { reconcileProblemsByPrefix } from './problems';
import type { WorkspaceProblem } from './shared/types/problems';
import { formatUnifiedTimestamp } from './shared/utils/time';
import type { Tool } from './tool';
import { getTool, getToolset, listToolsets } from './tools/registry';

export class Team {
  readonly memberDefaults: Team.Member;
  defaultResponder?: string;
  readonly members: Record<string, Team.Member>;

  constructor(params: {
    memberDefaults?: Team.Member;
    defaultResponder?: string;
    members?: Record<string, Team.Member>;
  }) {
    this.memberDefaults =
      params.memberDefaults ||
      new Team.Member({
        id: 'defaulter',
        name: 'Defaulter',
      });
    this.defaultResponder = params.defaultResponder;
    this.members = params.members || {};
  }

  getDefaultResponder(): Team.Member | undefined {
    const explicit = this.getMember(this.defaultResponder);
    if (explicit) return explicit;
    // Fallback: pick the first visible member, else Fuxi, else any member.
    const all = Object.values(this.members);
    const visible = all.find((m) => m.hidden !== true);
    if (visible) return visible;
    const fuxi = this.getMember('fuxi');
    if (fuxi) return fuxi;
    return all.length > 0 ? all[0] : undefined;
  }

  getMember(id: string | undefined): Team.Member | undefined {
    if (!id) return undefined;
    return this.members[id];
  }
}

export namespace Team {
  const TEAM_YAML_PATH = '.minds/team.yaml';
  const TEAM_YAML_PROBLEM_PREFIX = 'team/team_yaml_error/';

  export interface ModelParams {
    // General parameters that can be used by any provider
    max_tokens?: number; // Maximum tokens to generate (provider-agnostic)

    // OpenAI specific parameters
    openai?: {
      temperature?: number; // 0-2, controls randomness
      max_tokens?: number; // Maximum tokens to generate
      top_p?: number; // 0-1, nucleus sampling
      frequency_penalty?: number; // -2 to 2, penalize frequent tokens
      presence_penalty?: number; // -2 to 2, penalize present tokens
      seed?: number; // For deterministic outputs
      logprobs?: boolean; // Return log probabilities
      top_logprobs?: number; // Number of most likely tokens to return
      stop?: string | string[]; // Stop sequences
      logit_bias?: Record<string, number>; // Modify likelihood of specific tokens
      user?: string; // User identifier for abuse monitoring
      reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'; // For o1/reasoning models
      verbosity?: 'low' | 'medium' | 'high'; // Control response detail level (GPT-5 series)
    };

    // Anthropic specific parameters
    anthropic?: {
      temperature?: number; // 0-1, controls randomness
      max_tokens?: number; // Maximum tokens to generate
      top_p?: number; // 0-1, nucleus sampling
      top_k?: number; // Top-k sampling
      stop_sequences?: string[]; // Stop sequences
      reasoning_split?: boolean; // Enable separated reasoning stream if supported
    };
  }

  /**
   * Represents a team member or a member defaults object.
   *
   * All fields are optional so this class can also be used to hold defaults
   * (e.g., member_defaults in team.yaml).
   */
  /**
   * Team.Member
   *
   * Represents an agent/member with model/provider and tool configuration.
   * Also supports resolving toolsets into concrete tool lists.
   */
  export class Member {
    readonly id: string;
    name: string;
    provider?: string;
    model?: string;
    gofor?: string[] | Record<string, string>;
    toolsets?: string[];
    tools?: string[];
    model_params?: ModelParams;
    read_dirs?: string[];
    write_dirs?: string[];
    no_read_dirs?: string[];
    no_write_dirs?: string[];
    icon?: string;
    streaming?: boolean;
    hidden?: boolean;

    constructor(params: {
      id: string;
      name: string;
      provider?: string;
      model?: string;
      gofor?: string[] | Record<string, string>;
      toolsets?: string[];
      tools?: string[];
      model_params?: ModelParams;
      read_dirs?: string[];
      write_dirs?: string[];
      no_read_dirs?: string[];
      no_write_dirs?: string[];
      icon?: string;
      streaming?: boolean;
      hidden?: boolean;
    }) {
      this.id = params.id;
      this.name = params.name;
      // Only assign provided fields; omit undefined so prototype fallback can apply
      if (params.provider !== undefined) this.provider = params.provider;
      if (params.model !== undefined) this.model = params.model;
      // Only assign provided fields; omit undefined so prototype fallback can apply
      if (params.gofor !== undefined) this.gofor = params.gofor;
      if (params.toolsets !== undefined) this.toolsets = params.toolsets;
      if (params.tools !== undefined) this.tools = params.tools;
      if (params.model_params !== undefined) this.model_params = params.model_params;
      if (params.read_dirs !== undefined) this.read_dirs = params.read_dirs;
      if (params.write_dirs !== undefined) this.write_dirs = params.write_dirs;
      if (params.no_read_dirs !== undefined) this.no_read_dirs = params.no_read_dirs;
      if (params.no_write_dirs !== undefined) this.no_write_dirs = params.no_write_dirs;
      if (params.icon !== undefined) this.icon = params.icon;
      if (params.streaming !== undefined) this.streaming = params.streaming;
      if (params.hidden !== undefined) this.hidden = params.hidden;

      // TypeScript class-field initialization may define optional fields as own-properties with
      // `undefined`, which breaks prototype-chain defaults. Clean them up.
      const self = this as unknown as Record<string, unknown>;
      const unsettableKeys = [
        'provider',
        'model',
        'gofor',
        'toolsets',
        'tools',
        'model_params',
        'read_dirs',
        'write_dirs',
        'no_read_dirs',
        'no_write_dirs',
        'icon',
        'streaming',
        'hidden',
      ] as const;
      for (const key of unsettableKeys) {
        if (Object.prototype.hasOwnProperty.call(self, key) && self[key] === undefined) {
          delete self[key];
        }
      }
    }

    setName(name: string): void {
      this.name = name;
    }

    setProvider(provider: string | undefined): void {
      if (provider === undefined) {
        delete this.provider;
        return;
      }
      this.provider = provider;
    }

    setModel(model: string | undefined): void {
      if (model === undefined) {
        delete this.model;
        return;
      }
      this.model = model;
    }

    setGofor(gofor: string[] | Record<string, string> | undefined): void {
      if (gofor === undefined) {
        delete this.gofor;
        return;
      }
      this.gofor = gofor;
    }

    setToolsets(toolsets: string[] | undefined): void {
      if (toolsets === undefined) {
        delete this.toolsets;
        return;
      }
      this.toolsets = toolsets;
    }

    setTools(tools: string[] | undefined): void {
      if (tools === undefined) {
        delete this.tools;
        return;
      }
      this.tools = tools;
    }

    setModelParams(modelParams: ModelParams | undefined): void {
      if (modelParams === undefined) {
        delete this.model_params;
        return;
      }
      this.model_params = modelParams;
    }

    setReadDirs(readDirs: string[] | undefined): void {
      if (readDirs === undefined) {
        delete this.read_dirs;
        return;
      }
      this.read_dirs = readDirs;
    }

    setWriteDirs(writeDirs: string[] | undefined): void {
      if (writeDirs === undefined) {
        delete this.write_dirs;
        return;
      }
      this.write_dirs = writeDirs;
    }

    setNoReadDirs(noReadDirs: string[] | undefined): void {
      if (noReadDirs === undefined) {
        delete this.no_read_dirs;
        return;
      }
      this.no_read_dirs = noReadDirs;
    }

    setNoWriteDirs(noWriteDirs: string[] | undefined): void {
      if (noWriteDirs === undefined) {
        delete this.no_write_dirs;
        return;
      }
      this.no_write_dirs = noWriteDirs;
    }

    setIcon(icon: string | undefined): void {
      if (icon === undefined) {
        delete this.icon;
        return;
      }
      this.icon = icon;
    }

    setStreaming(streaming: boolean | undefined): void {
      if (streaming === undefined) {
        delete this.streaming;
        return;
      }
      this.streaming = streaming;
    }

    setHidden(hidden: boolean | undefined): void {
      if (hidden === undefined) {
        delete this.hidden;
        return;
      }
      this.hidden = hidden;
    }

    /**
     * Returns a flat list of Tool objects by resolving toolsets and merging with individual tools.
     * Honors declaration order of toolsets and tools. Logs warnings for duplicate tool names
     * that resolve to different Tool objects. Returns no duplicate tools per name.
     */
    listTools(): Tool[] {
      const toolMap = new Map<string, Tool>();
      const seenNames = new Set<string>();

      // Process toolsets (in declaration order)
      if (this.toolsets) {
        const excludedToolsets = new Set<string>();
        for (const entry of this.toolsets) {
          if (entry.startsWith('!') && entry.length > 1) {
            excludedToolsets.add(entry.slice(1));
          }
        }

        for (const toolsetName of this.toolsets) {
          if (toolsetName.startsWith('!')) continue;
          const toolsetNames =
            toolsetName === '*'
              ? Object.keys(listToolsets()).filter((n) => !excludedToolsets.has(n))
              : excludedToolsets.has(toolsetName)
                ? []
                : [toolsetName];

          for (const resolvedToolsetName of toolsetNames) {
            const tools = getToolset(resolvedToolsetName);
            if (!tools) {
              log.warn(
                `Toolset '${resolvedToolsetName}' not found in registry for member '${this.id}'`,
              );
              continue;
            }

            for (const tool of tools) {
              if (seenNames.has(tool.name)) {
                const existingTool = toolMap.get(tool.name);
                if (existingTool && existingTool !== tool) {
                  log.warn(
                    `Tool name '${tool.name}' resolves to different Tool objects for member '${this.id}'. Using first occurrence.`,
                  );
                }
                continue; // Skip duplicate
              }

              toolMap.set(tool.name, tool);
              seenNames.add(tool.name);
            }
          }
        }
      }

      // Process individual tools (in declaration order)
      if (this.tools) {
        for (const toolName of this.tools) {
          const tool = getTool(toolName);
          if (!tool) {
            log.warn(`Tool '${toolName}' not found in registry for member '${this.id}'`);
            continue;
          }

          if (seenNames.has(toolName)) {
            const existingTool = toolMap.get(toolName);
            if (existingTool && existingTool !== tool) {
              log.warn(
                `Tool name '${toolName}' resolves to different Tool objects for member '${this.id}'. Using first occurrence.`,
              );
            }
            continue; // Skip duplicate
          }

          toolMap.set(toolName, tool);
          seenNames.add(toolName);
        }
      }

      return Array.from(toolMap.values());
    }
  }

  // Team config support: load .minds/team.yaml
  export async function load(): Promise<Team> {
    const md = new Team.Member({
      id: 'defaulter',
      name: 'Defaulter',
    });

    const fuxi = new Team.Member({
      id: 'fuxi',
      name: '伏羲(Fuxi)',
      icon: '☯️',
      hidden: true,
      toolsets: ['team-mgmt'],
    });
    Object.setPrototypeOf(fuxi, md);

    // Use `*` to include toolsets registered later (e.g., hot-reloaded MCP toolsets),
    // and exclude the team-management toolset.
    const pangu = new Team.Member({
      id: 'pangu',
      name: '盘古(Pangu)',
      icon: '⛰️',
      hidden: true,
      toolsets: ['*', '!team-mgmt'],
      no_read_dirs: ['.minds/**'],
      no_write_dirs: ['.minds/**'],
    });
    Object.setPrototypeOf(pangu, md);

    const issuesById = new Map<string, { message: string; errorText: string }>();
    const addIssue = (id: string, message: string, errorText: string): void => {
      issuesById.set(id, { message, errorText });
    };

    const finalizeProblems = (): void => {
      const now = formatUnifiedTimestamp(new Date());
      const desired: WorkspaceProblem[] = [];
      for (const [id, issue] of issuesById.entries()) {
        desired.push({
          kind: 'team_workspace_config_error',
          source: 'team',
          id: TEAM_YAML_PROBLEM_PREFIX + id,
          severity: 'error',
          timestamp: now,
          message: issue.message,
          detail: { filePath: TEAM_YAML_PATH, errorText: issue.errorText },
        });
      }
      reconcileProblemsByPrefix(TEAM_YAML_PROBLEM_PREFIX, desired);
    };

    const buildBootstrapTeam = async (): Promise<Team> => {
      try {
        await applyBootstrapMemberDefaults(md);
      } catch (err: unknown) {
        log.warn(
          `Failed to apply bootstrap member defaults: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return new Team({
        memberDefaults: md,
        defaultResponder: 'fuxi',
        members: { fuxi, pangu },
      });
    };

    try {
      await fs.access(TEAM_YAML_PATH);
    } catch {
      // When rtws doesn't have a team definition, construct a minimal team with
      // shadow/hidden members for bootstrap.
      const team = await buildBootstrapTeam();
      finalizeProblems();
      return team;
    }

    let team: Team;
    try {
      const raw = await fs.readFile(TEAM_YAML_PATH, 'utf-8');
      let parsed: unknown;
      try {
        parsed = YAML.parse(raw);
      } catch (err: unknown) {
        addIssue(
          'parse',
          'Failed to parse .minds/team.yaml.',
          err instanceof Error ? err.message : String(err),
        );
        team = await buildBootstrapTeam();
        finalizeProblems();
        return team;
      }

      const parsedTeam = parseTeamYamlObject(parsed, md, { fuxi, pangu });
      for (const issue of parsedTeam.issues) {
        addIssue(issue.id, issue.message, issue.errorText);
      }

      team = parsedTeam.team;
    } catch (err: unknown) {
      addIssue(
        'read',
        'Failed to load .minds/team.yaml.',
        err instanceof Error ? err.message : String(err),
      );
      team = await buildBootstrapTeam();
      finalizeProblems();
      return team;
    }

    // Always include fuxi + pangu as shadow members, even if team.yaml exists.
    enforceShadowMemberDefaults(fuxi, pangu);
    team.members['fuxi'] = fuxi;
    team.members['pangu'] = pangu;

    const configuredDefaultResponder = team.defaultResponder;

    // Normalize default responder (even if team.yaml omitted it).
    const def = team.getDefaultResponder();
    team.defaultResponder = def ? def.id : 'fuxi';

    // If member_defaults provider/model are missing after parsing, try to recover from llm.yaml.
    try {
      await applyBootstrapMemberDefaults(md);
    } catch (err: unknown) {
      // Fail open: Team must remain usable even if llm.yaml cannot be loaded.
      log.warn(
        `Failed to recover missing member_defaults provider/model from llm config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!md.provider) {
      addIssue(
        'member_defaults/provider',
        'Invalid .minds/team.yaml: missing member_defaults.provider.',
        'member_defaults.provider is required (or must be recoverable from .minds/llm.yaml).',
      );
    }
    if (!md.model) {
      addIssue(
        'member_defaults/model',
        'Invalid .minds/team.yaml: missing member_defaults.model.',
        'member_defaults.model is required (or must be recoverable from .minds/llm.yaml).',
      );
    }

    if (configuredDefaultResponder && !team.getMember(configuredDefaultResponder)) {
      addIssue(
        'default_responder/unknown',
        'Invalid .minds/team.yaml: default_responder does not match any member.',
        `default_responder '${configuredDefaultResponder}' does not exist in team members.`,
      );
    }

    finalizeProblems();
    return team;
  }

  async function applyBootstrapMemberDefaults(md: Team.Member): Promise<void> {
    if (md.provider && md.model) return;

    const llmCfg = await LlmConfig.load();
    const providerEntries = Object.entries(llmCfg.providers);

    const tryPickProvider = (key: string): void => {
      if (!md.provider) md.setProvider(key);

      const providerKey = md.provider;
      if (!providerKey) return;
      const modelKeys = Object.keys(llmCfg.providers[providerKey]?.models ?? {});
      if (!md.model && modelKeys.length > 0) md.setModel(modelKeys[0]);
    };

    // Prefer a provider with an available API key env var.
    for (const [key, providerConfig] of providerEntries) {
      if (process.env[providerConfig.apiKeyEnvVar]) {
        tryPickProvider(key);
        break;
      }
    }

    // Fall back to the first configured provider.
    if (!md.provider && providerEntries.length > 0) {
      tryPickProvider(providerEntries[0][0]);
    }

    // If provider is set but model is missing, try to pick a model for that provider.
    if (md.provider && !md.model) {
      tryPickProvider(md.provider);
    }
  }

  function enforceShadowMemberDefaults(fuxi: Team.Member, pangu: Team.Member): void {
    // fuxi: always hidden + always has team-mgmt available
    fuxi.setHidden(true);
    const fuxiToolsets = fuxi.toolsets ? [...fuxi.toolsets] : [];
    const withoutExclude = fuxiToolsets.filter((t) => t !== '!team-mgmt');
    if (!withoutExclude.includes('team-mgmt')) withoutExclude.unshift('team-mgmt');
    fuxi.setToolsets(withoutExclude);

    // pangu: always hidden + never has team-mgmt + never reads/writes .minds/**
    pangu.setHidden(true);
    const panguToolsets = pangu.toolsets ? [...pangu.toolsets] : [];
    const withoutMgmt = panguToolsets.filter((t) => t !== 'team-mgmt');
    if (!withoutMgmt.includes('!team-mgmt')) withoutMgmt.push('!team-mgmt');
    if (!withoutMgmt.includes('*')) withoutMgmt.unshift('*');
    pangu.setToolsets(withoutMgmt);

    const mindsScope = '.minds/**';
    const panguNoRead = pangu.no_read_dirs ? [...pangu.no_read_dirs] : [];
    if (!panguNoRead.includes(mindsScope)) panguNoRead.push(mindsScope);
    pangu.setNoReadDirs(panguNoRead);

    const panguNoWrite = pangu.no_write_dirs ? [...pangu.no_write_dirs] : [];
    if (!panguNoWrite.includes(mindsScope)) panguNoWrite.push(mindsScope);
    pangu.setNoWriteDirs(panguNoWrite);
  }

  function hasOwnKey(obj: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function requireDefined<T>(value: T | undefined, at: string): T {
    if (value === undefined) {
      throw new Error(`Invalid ${at}: value required (got ${describeValueType(value)})`);
    }
    return value;
  }

  type TeamYamlIssue = { id: string; message: string; errorText: string };

  function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function sanitizeProblemIdSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function asErrorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  type MemberOverrides = {
    name?: string;
    provider?: string;
    model?: string;
    gofor?: string[] | Record<string, string>;
    toolsets?: string[];
    tools?: string[];
    model_params?: ModelParams;
    read_dirs?: string[];
    write_dirs?: string[];
    no_read_dirs?: string[];
    no_write_dirs?: string[];
    icon?: string;
    streaming?: boolean;
    hidden?: boolean;
  };

  function parseMemberOverrides(
    rv: Record<string, unknown>,
    at: string,
  ): { kind: 'ok'; overrides: MemberOverrides } | { kind: 'error'; errorTexts: string[] } {
    const overrides: MemberOverrides = {};
    const errors: string[] = [];

    if (hasOwnKey(rv, 'name')) {
      try {
        overrides.name = requireDefined(asOptionalString(rv['name'], `${at}.name`), `${at}.name`);
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'provider')) {
      try {
        overrides.provider = requireDefined(
          asOptionalString(rv['provider'], `${at}.provider`),
          `${at}.provider`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'model')) {
      try {
        overrides.model = requireDefined(
          asOptionalString(rv['model'], `${at}.model`),
          `${at}.model`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'gofor')) {
      try {
        overrides.gofor = requireDefined(
          asOptionalGofor(rv['gofor'], `${at}.gofor`),
          `${at}.gofor`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'toolsets')) {
      try {
        overrides.toolsets = requireDefined(
          asOptionalStringArray(rv['toolsets'], `${at}.toolsets`),
          `${at}.toolsets`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'tools')) {
      try {
        overrides.tools = requireDefined(
          asOptionalStringArray(rv['tools'], `${at}.tools`),
          `${at}.tools`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'model_params')) {
      try {
        overrides.model_params = requireDefined(
          asOptionalModelParams(rv['model_params'], `${at}.model_params`),
          `${at}.model_params`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'read_dirs')) {
      try {
        overrides.read_dirs = requireDefined(
          asOptionalStringArray(rv['read_dirs'], `${at}.read_dirs`),
          `${at}.read_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'write_dirs')) {
      try {
        overrides.write_dirs = requireDefined(
          asOptionalStringArray(rv['write_dirs'], `${at}.write_dirs`),
          `${at}.write_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_read_dirs')) {
      try {
        overrides.no_read_dirs = requireDefined(
          asOptionalStringArray(rv['no_read_dirs'], `${at}.no_read_dirs`),
          `${at}.no_read_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'no_write_dirs')) {
      try {
        overrides.no_write_dirs = requireDefined(
          asOptionalStringArray(rv['no_write_dirs'], `${at}.no_write_dirs`),
          `${at}.no_write_dirs`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'icon')) {
      try {
        overrides.icon = requireDefined(asOptionalString(rv['icon'], `${at}.icon`), `${at}.icon`);
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'streaming')) {
      try {
        overrides.streaming = requireDefined(
          asOptionalBoolean(rv['streaming'], `${at}.streaming`),
          `${at}.streaming`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }
    if (hasOwnKey(rv, 'hidden')) {
      try {
        overrides.hidden = requireDefined(
          asOptionalBoolean(rv['hidden'], `${at}.hidden`),
          `${at}.hidden`,
        );
      } catch (err: unknown) {
        errors.push(asErrorText(err));
      }
    }

    if (errors.length > 0) return { kind: 'error', errorTexts: errors };
    return { kind: 'ok', overrides };
  }

  function applyOverrides(member: Team.Member, overrides: MemberOverrides): void {
    if (overrides.name !== undefined) member.setName(overrides.name);
    if (overrides.provider !== undefined) member.setProvider(overrides.provider);
    if (overrides.model !== undefined) member.setModel(overrides.model);
    if (overrides.gofor !== undefined) member.setGofor(overrides.gofor);
    if (overrides.toolsets !== undefined) member.setToolsets(overrides.toolsets);
    if (overrides.tools !== undefined) member.setTools(overrides.tools);
    if (overrides.model_params !== undefined) member.setModelParams(overrides.model_params);
    if (overrides.read_dirs !== undefined) member.setReadDirs(overrides.read_dirs);
    if (overrides.write_dirs !== undefined) member.setWriteDirs(overrides.write_dirs);
    if (overrides.no_read_dirs !== undefined) member.setNoReadDirs(overrides.no_read_dirs);
    if (overrides.no_write_dirs !== undefined) member.setNoWriteDirs(overrides.no_write_dirs);
    if (overrides.icon !== undefined) member.setIcon(overrides.icon);
    if (overrides.streaming !== undefined) member.setStreaming(overrides.streaming);
    if (overrides.hidden !== undefined) member.setHidden(overrides.hidden);
  }

  function parseTeamYamlObject(
    obj: unknown,
    md: Team.Member,
    shadow: { fuxi: Team.Member; pangu: Team.Member },
  ): { team: Team; issues: TeamYamlIssue[] } {
    const issues: TeamYamlIssue[] = [];
    const pushIssue = (id: string, message: string, errorText: string): void => {
      issues.push({ id, message, errorText });
    };

    const teamObj: Record<string, unknown> = (() => {
      if (isRecordValue(obj)) return obj;
      pushIssue(
        'root',
        'Invalid .minds/team.yaml: expected an object at root.',
        `Invalid team config: expected an object (got ${describeValueType(obj)})`,
      );
      return {};
    })();

    // member_defaults
    const rawMemberDefaults = teamObj.member_defaults;
    if (rawMemberDefaults !== undefined) {
      if (!isRecordValue(rawMemberDefaults)) {
        pushIssue(
          'member_defaults',
          'Invalid .minds/team.yaml: member_defaults must be an object.',
          `Invalid member_defaults: expected an object (got ${describeValueType(rawMemberDefaults)})`,
        );
      } else {
        const parsedMd = parseMemberOverrides(rawMemberDefaults, 'member_defaults');
        if (parsedMd.kind === 'ok') {
          applyOverrides(md, parsedMd.overrides);
        } else {
          pushIssue(
            'member_defaults',
            'Invalid .minds/team.yaml: member_defaults has invalid fields.',
            parsedMd.errorTexts.join('\n'),
          );
        }
      }
    }

    // default_responder
    let defResp: string | undefined;
    if (teamObj.default_responder !== undefined) {
      try {
        defResp = asOptionalString(teamObj.default_responder, 'default_responder');
      } catch (err: unknown) {
        pushIssue(
          'default_responder/type',
          'Invalid .minds/team.yaml: default_responder must be a string.',
          asErrorText(err),
        );
      }
    }

    const membersRec: Record<string, Team.Member> = {};
    const rawMembers = teamObj.members;
    const membersObj: Record<string, unknown> = (() => {
      if (rawMembers === undefined) return {};
      if (isRecordValue(rawMembers)) return rawMembers;
      pushIssue(
        'members',
        'Invalid .minds/team.yaml: members must be an object.',
        `Invalid members: expected an object (got ${describeValueType(rawMembers)})`,
      );
      return {};
    })();

    for (const [id, raw] of Object.entries(membersObj)) {
      const memberAt = `members.${id}`;
      const idSeg = sanitizeProblemIdSegment(id);

      if (!isRecordValue(raw)) {
        pushIssue(
          `members/${idSeg}`,
          `Invalid .minds/team.yaml: ${memberAt} must be an object.`,
          `Invalid ${memberAt}: expected an object (got ${describeValueType(raw)})`,
        );
        continue;
      }

      const parsedMember = parseMemberOverrides(raw, memberAt);
      if (parsedMember.kind === 'error') {
        pushIssue(
          `members/${idSeg}`,
          `Invalid .minds/team.yaml: ${memberAt} has invalid fields.`,
          parsedMember.errorTexts.join('\n'),
        );
        if (id === 'fuxi' || id === 'pangu') {
          // Shadow members are always present; ignore overrides on invalid config.
          const shadowMember = id === 'fuxi' ? shadow.fuxi : shadow.pangu;
          Object.setPrototypeOf(shadowMember, md);
          membersRec[id] = shadowMember;
        }
        continue;
      }

      if (id === 'fuxi' || id === 'pangu') {
        const shadowMember = id === 'fuxi' ? shadow.fuxi : shadow.pangu;
        applyOverrides(shadowMember, parsedMember.overrides);
        Object.setPrototypeOf(shadowMember, md);
        membersRec[id] = shadowMember;
        continue;
      }

      const m = new Team.Member({ id, name: id });
      applyOverrides(m, parsedMember.overrides);
      Object.setPrototypeOf(m, md);
      membersRec[id] = m;
    }

    return {
      team: new Team({ memberDefaults: md, defaultResponder: defResp, members: membersRec }),
      issues,
    };
  }

  function asRecord(value: unknown, at: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Invalid ${at}: expected an object (got ${describeValueType(value)})`);
    }
    return value as Record<string, unknown>;
  }

  function asString(value: unknown, at: string): string {
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalString(value: unknown, at: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalBoolean(value: unknown, at: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid ${at}: expected a boolean (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalNumber(value: unknown, at: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
      throw new Error(`Invalid ${at}: expected a number (got ${describeValueType(value)})`);
    }
    return value;
  }

  function asOptionalStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`Invalid ${at}: expected string[] (got ${describeValueType(value)})`);
    }
    return value;
  }

  function describeValueType(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';

    if (Array.isArray(value)) {
      if (value.length === 0) return 'unknown[]';

      const elementTypes = new Set<string>();
      for (const v of value) {
        if (v === undefined) elementTypes.add('undefined');
        else if (v === null) elementTypes.add('null');
        else if (Array.isArray(v)) elementTypes.add('unknown[]');
        else elementTypes.add(typeof v);
      }

      const t = Array.from(elementTypes).sort();
      if (t.length === 1) return `${t[0]}[]`;
      return `(${t.join('|')})[]`;
    }

    return typeof value;
  }

  function asOptionalStringOrStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
    throw new Error(`Invalid ${at}: expected string|string[] (got ${describeValueType(value)})`);
  }

  function asOptionalGofor(
    value: unknown,
    at: string,
  ): string[] | Record<string, string> | undefined {
    if (value === undefined) return undefined;

    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;

    if (isRecordValue(value)) {
      const obj = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') {
          throw new Error(`Invalid ${at}.${k}: expected string (got ${describeValueType(v)})`);
        }
      }
      return obj as Record<string, string>;
    }

    throw new Error(
      `Invalid ${at}: expected string|string[]|Record<string,string> (got ${describeValueType(value)})`,
    );
  }

  function asOptionalStop(value: unknown, at: string): string | string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
    throw new Error(`Invalid ${at}: expected string|string[] (got ${describeValueType(value)})`);
  }

  function asOptionalLogitBias(value: unknown, at: string): Record<string, number> | undefined {
    if (value === undefined) return undefined;
    const obj = asRecord(value, at);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number') {
        throw new Error(`Invalid ${at}.${k}: expected a number (got ${describeValueType(v)})`);
      }
    }
    return obj as Record<string, number>;
  }

  function asOptionalModelParams(value: unknown, at: string): ModelParams | undefined {
    if (value === undefined) return undefined;
    const obj = asRecord(value, at);

    const openai = obj.openai === undefined ? undefined : asRecord(obj.openai, `${at}.openai`);
    const anthropic =
      obj.anthropic === undefined ? undefined : asRecord(obj.anthropic, `${at}.anthropic`);

    if (openai) {
      asOptionalNumber(openai.temperature, `${at}.openai.temperature`);
      asOptionalNumber(openai.max_tokens, `${at}.openai.max_tokens`);
      asOptionalNumber(openai.top_p, `${at}.openai.top_p`);
      asOptionalNumber(openai.frequency_penalty, `${at}.openai.frequency_penalty`);
      asOptionalNumber(openai.presence_penalty, `${at}.openai.presence_penalty`);
      asOptionalNumber(openai.seed, `${at}.openai.seed`);
      asOptionalBoolean(openai.logprobs, `${at}.openai.logprobs`);
      asOptionalNumber(openai.top_logprobs, `${at}.openai.top_logprobs`);
      asOptionalStop(openai.stop, `${at}.openai.stop`);
      asOptionalLogitBias(openai.logit_bias, `${at}.openai.logit_bias`);
      asOptionalString(openai.user, `${at}.openai.user`);
      const reasoningEffort = openai.reasoning_effort;
      if (
        reasoningEffort !== undefined &&
        reasoningEffort !== 'minimal' &&
        reasoningEffort !== 'low' &&
        reasoningEffort !== 'medium' &&
        reasoningEffort !== 'high'
      ) {
        throw new Error(
          `Invalid ${at}.openai.reasoning_effort: expected minimal|low|medium|high (got ${describeValueType(
            reasoningEffort,
          )})`,
        );
      }

      const verbosity = openai.verbosity;
      if (
        verbosity !== undefined &&
        verbosity !== 'low' &&
        verbosity !== 'medium' &&
        verbosity !== 'high'
      ) {
        throw new Error(
          `Invalid ${at}.openai.verbosity: expected low|medium|high (got ${describeValueType(
            verbosity,
          )})`,
        );
      }
    }

    if (anthropic) {
      asOptionalNumber(anthropic.temperature, `${at}.anthropic.temperature`);
      asOptionalNumber(anthropic.max_tokens, `${at}.anthropic.max_tokens`);
      asOptionalNumber(anthropic.top_p, `${at}.anthropic.top_p`);
      asOptionalNumber(anthropic.top_k, `${at}.anthropic.top_k`);
      asOptionalStringArray(anthropic.stop_sequences, `${at}.anthropic.stop_sequences`);
      asOptionalBoolean(anthropic.reasoning_split, `${at}.anthropic.reasoning_split`);
    }

    asOptionalNumber(obj.max_tokens, `${at}.max_tokens`);

    return obj as ModelParams;
  }
}
