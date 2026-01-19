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

    // Fallback: pick the first visible member, else any member.
    const all = Object.values(this.members);
    const visible = all.find((m) => m.hidden !== true);
    if (visible) return visible;
    const pangu = this.getMember('pangu');
    if (pangu) return pangu;
    return all.length > 0 ? all[0] : undefined;
  }

  getMember(id: string | undefined): Team.Member | undefined {
    if (!id) return undefined;
    return this.members[id];
  }
}

export namespace Team {
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
    gofor?: string[];
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
      gofor?: string[];
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

    setGofor(gofor: string[] | undefined): void {
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
    const teamPath = '.minds/team.yaml';

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

    try {
      await fs.access(teamPath);
    } catch {
      // When rtws doesn't have a team definition, construct a minimal team with
      // shadow/hidden members for bootstrap.
      const llmCfg = await LlmConfig.load();
      const providerEntries = Object.entries(llmCfg.providers);
      const pickProvider = (key: string): void => {
        md.setProvider(key);
        const modelKeys = Object.keys(llmCfg.providers[key]?.models ?? {});
        if (modelKeys.length > 0) md.setModel(modelKeys[0]);
      };
      // Prefer a provider with an available API key env var.
      for (const [key, providerConfig] of providerEntries) {
        if (process.env[providerConfig.apiKeyEnvVar]) {
          pickProvider(key);
          break;
        }
      }
      // Fall back to the first configured provider.
      if (!md.provider && providerEntries.length > 0) {
        pickProvider(providerEntries[0][0]);
      }
      return new Team({
        memberDefaults: md,
        defaultResponder: 'pangu',
        members: { fuxi, pangu },
      });
    }

    const raw = await fs.readFile(teamPath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    const team = fromYamlObject(parsed, md, { fuxi, pangu });

    // Always include fuxi + pangu as shadow members, even if team.yaml exists.
    enforceShadowMemberDefaults(fuxi, pangu);
    team.members['fuxi'] = fuxi;
    team.members['pangu'] = pangu;

    // Normalize default responder (even if team.yaml omitted it).
    const def = team.getDefaultResponder();
    team.defaultResponder = def ? def.id : 'fuxi';

    return team;
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
      throw new Error(`Invalid ${at}: value required`);
    }
    return value;
  }

  function applyMemberOverridesFromYamlRecord(
    member: Team.Member,
    rv: Record<string, unknown>,
    at: string,
  ): void {
    if (hasOwnKey(rv, 'name')) {
      member.setName(requireDefined(asOptionalString(rv['name'], `${at}.name`), `${at}.name`));
    }
    if (hasOwnKey(rv, 'provider')) {
      member.setProvider(
        requireDefined(asOptionalString(rv['provider'], `${at}.provider`), `${at}.provider`),
      );
    }
    if (hasOwnKey(rv, 'model')) {
      member.setModel(requireDefined(asOptionalString(rv['model'], `${at}.model`), `${at}.model`));
    }
    if (hasOwnKey(rv, 'gofor')) {
      member.setGofor(
        requireDefined(asOptionalStringOrStringArray(rv['gofor'], `${at}.gofor`), `${at}.gofor`),
      );
    }
    if (hasOwnKey(rv, 'toolsets')) {
      member.setToolsets(
        requireDefined(asOptionalStringArray(rv['toolsets'], `${at}.toolsets`), `${at}.toolsets`),
      );
    }
    if (hasOwnKey(rv, 'tools')) {
      member.setTools(
        requireDefined(asOptionalStringArray(rv['tools'], `${at}.tools`), `${at}.tools`),
      );
    }
    if (hasOwnKey(rv, 'model_params')) {
      member.setModelParams(
        requireDefined(
          asOptionalModelParams(rv['model_params'], `${at}.model_params`),
          `${at}.model_params`,
        ),
      );
    }
    if (hasOwnKey(rv, 'read_dirs')) {
      member.setReadDirs(
        requireDefined(
          asOptionalStringArray(rv['read_dirs'], `${at}.read_dirs`),
          `${at}.read_dirs`,
        ),
      );
    }
    if (hasOwnKey(rv, 'write_dirs')) {
      member.setWriteDirs(
        requireDefined(
          asOptionalStringArray(rv['write_dirs'], `${at}.write_dirs`),
          `${at}.write_dirs`,
        ),
      );
    }
    if (hasOwnKey(rv, 'no_read_dirs')) {
      member.setNoReadDirs(
        requireDefined(
          asOptionalStringArray(rv['no_read_dirs'], `${at}.no_read_dirs`),
          `${at}.no_read_dirs`,
        ),
      );
    }
    if (hasOwnKey(rv, 'no_write_dirs')) {
      member.setNoWriteDirs(
        requireDefined(
          asOptionalStringArray(rv['no_write_dirs'], `${at}.no_write_dirs`),
          `${at}.no_write_dirs`,
        ),
      );
    }
    if (hasOwnKey(rv, 'icon')) {
      member.setIcon(requireDefined(asOptionalString(rv['icon'], `${at}.icon`), `${at}.icon`));
    }
    if (hasOwnKey(rv, 'streaming')) {
      member.setStreaming(
        requireDefined(asOptionalBoolean(rv['streaming'], `${at}.streaming`), `${at}.streaming`),
      );
    }
    if (hasOwnKey(rv, 'hidden')) {
      member.setHidden(
        requireDefined(asOptionalBoolean(rv['hidden'], `${at}.hidden`), `${at}.hidden`),
      );
    }
  }

  function fromYamlObject(
    obj: unknown,
    md: Team.Member,
    shadow: { fuxi: Team.Member; pangu: Team.Member },
  ): Team {
    const teamObj = asRecord(obj, 'team config');
    const mdObj =
      teamObj.member_defaults === undefined
        ? {}
        : asRecord(teamObj.member_defaults, 'member_defaults');

    applyMemberOverridesFromYamlRecord(md, mdObj, 'member_defaults');

    const defResp = asOptionalString(teamObj.default_responder, 'default_responder');

    const membersRec: Record<string, Team.Member> = {};
    const membersObj = teamObj.members === undefined ? {} : asRecord(teamObj.members, 'members');
    for (const [id, raw] of Object.entries(membersObj)) {
      const rv = asRecord(raw, `members.${id}`);

      if (id === 'fuxi' || id === 'pangu') {
        const shadowMember = id === 'fuxi' ? shadow.fuxi : shadow.pangu;
        applyMemberOverridesFromYamlRecord(shadowMember, rv, `members.${id}`);
        Object.setPrototypeOf(shadowMember, md);
        membersRec[id] = shadowMember;
        continue;
      }

      const m = new Team.Member({ id, name: id });
      applyMemberOverridesFromYamlRecord(m, rv, `members.${id}`);
      Object.setPrototypeOf(m, md);
      membersRec[id] = m;
    }

    return new Team({ memberDefaults: md, defaultResponder: defResp, members: membersRec });
  }

  function asRecord(value: unknown, at: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Invalid ${at}: expected an object`);
    }
    return value as Record<string, unknown>;
  }

  function asString(value: unknown, at: string): string {
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string`);
    }
    return value;
  }

  function asOptionalString(value: unknown, at: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${at}: expected a string`);
    }
    return value;
  }

  function asOptionalBoolean(value: unknown, at: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid ${at}: expected a boolean`);
    }
    return value;
  }

  function asOptionalNumber(value: unknown, at: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
      throw new Error(`Invalid ${at}: expected a number`);
    }
    return value;
  }

  function asOptionalStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`Invalid ${at}: expected string[]`);
    }
    return value;
  }

  function asOptionalStringOrStringArray(value: unknown, at: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return [value];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
    throw new Error(`Invalid ${at}: expected string|string[]`);
  }

  function asOptionalStop(value: unknown, at: string): string | string[] | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
    throw new Error(`Invalid ${at}: expected string|string[]`);
  }

  function asOptionalLogitBias(value: unknown, at: string): Record<string, number> | undefined {
    if (value === undefined) return undefined;
    const obj = asRecord(value, at);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'number') {
        throw new Error(`Invalid ${at}.${k}: expected a number`);
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
      if (
        openai.reasoning_effort !== undefined &&
        openai.reasoning_effort !== 'minimal' &&
        openai.reasoning_effort !== 'low' &&
        openai.reasoning_effort !== 'medium' &&
        openai.reasoning_effort !== 'high'
      ) {
        throw new Error(`Invalid ${at}.openai.reasoning_effort`);
      }
      if (
        openai.verbosity !== undefined &&
        openai.verbosity !== 'low' &&
        openai.verbosity !== 'medium' &&
        openai.verbosity !== 'high'
      ) {
        throw new Error(`Invalid ${at}.openai.verbosity`);
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
