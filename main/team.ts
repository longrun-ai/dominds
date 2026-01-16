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
  readonly defaultResponder?: string;
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
    return this.getMember(this.defaultResponder);
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
    readonly name: string;
    readonly provider?: string;
    readonly model?: string;
    readonly gofor?: string[];
    readonly toolsets?: string[];
    readonly tools?: string[];
    readonly model_params?: ModelParams;
    readonly read_dirs?: string[];
    readonly write_dirs?: string[];
    readonly no_read_dirs?: string[];
    readonly no_write_dirs?: string[];
    readonly icon?: string;
    readonly streaming?: boolean;

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
      ] as const;
      for (const key of unsettableKeys) {
        if (Object.prototype.hasOwnProperty.call(self, key) && self[key] === undefined) {
          delete self[key];
        }
      }
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
        for (const toolsetName of this.toolsets) {
          const toolsetNames =
            toolsetName === '*' ? Object.keys(listToolsets()) : ([toolsetName] as const);

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
    try {
      await fs.access(teamPath);
    } catch {
      // when rtws doesn't have team definition, construct it with 帝江,
      // with first(default) model from first provider configured (by env var)
      const llmCfg = await LlmConfig.load();
      let provider = '';
      let model = '';
      const providerEntries = Object.entries(llmCfg.providers);
      const pickProvider = (key: string): void => {
        provider = key;
        const modelKeys = Object.keys(llmCfg.providers[key]?.models ?? {});
        if (modelKeys.length > 0) model = modelKeys[0];
      };

      // Prefer a provider with an available API key env var.
      for (const [key, providerConfig] of providerEntries) {
        if (process.env[providerConfig.apiKeyEnvVar]) {
          pickProvider(key);
          break;
        }
      }
      // Fall back to the first configured provider.
      if (!provider && providerEntries.length > 0) {
        pickProvider(providerEntries[0][0]);
      }

      // Ad-hoc team grants all currently-registered toolsets to dijiang (for UX/e2e),
      // and env toolset to cmdr.
      // Use `*` to include toolsets registered later (e.g., hot-reloaded MCP toolsets).
      const allToolsets = ['*'];

      const dijiang = new Team.Member({
        id: 'dijiang',
        icon: '💥',
        name: 'Dijiang',
        provider,
        model,
        toolsets: allToolsets,
      });
      const team: Team = new Team({
        memberDefaults: dijiang,
        defaultResponder: 'dijiang',
        members: {
          dijiang,
          cmdr: new Team.Member({
            id: 'cmdr',
            icon: 'ᯓ★',
            name: 'Commander',
            provider,
            model,
            toolsets: ['os', 'env'],
          }),
        },
      });
      return team;
    }
    const raw = await fs.readFile(teamPath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    const team = fromYamlObject(parsed);
    return team;
  }

  function fromYamlObject(obj: unknown): Team {
    const teamObj = asRecord(obj, 'team config');
    const mdObj = asRecord(teamObj.member_defaults, 'member_defaults');

    const provider = asString(mdObj.provider, 'member_defaults.provider');
    const model = asString(mdObj.model, 'member_defaults.model');

    const md = new Team.Member({
      id: 'defaulter',
      name: 'Defaulter',
      provider,
      model,
      gofor: asOptionalStringArray(mdObj.gofor, 'member_defaults.gofor'),
      toolsets: asOptionalStringArray(mdObj.toolsets, 'member_defaults.toolsets'),
      tools: asOptionalStringArray(mdObj.tools, 'member_defaults.tools'),
      model_params: asOptionalModelParams(mdObj.model_params, 'member_defaults.model_params'),
      read_dirs: asOptionalStringArray(mdObj.read_dirs, 'member_defaults.read_dirs'),
      write_dirs: asOptionalStringArray(mdObj.write_dirs, 'member_defaults.write_dirs'),
      no_read_dirs: asOptionalStringArray(mdObj.no_read_dirs, 'member_defaults.no_read_dirs'),
      no_write_dirs: asOptionalStringArray(mdObj.no_write_dirs, 'member_defaults.no_write_dirs'),
      icon: asOptionalString(mdObj.icon, 'member_defaults.icon'),
      streaming: asOptionalBoolean(mdObj.streaming, 'member_defaults.streaming'),
    });

    const defResp = asOptionalString(teamObj.default_responder, 'default_responder');

    const membersRec: Record<string, Team.Member> = {};
    const membersObj = teamObj.members === undefined ? {} : asRecord(teamObj.members, 'members');
    for (const [id, raw] of Object.entries(membersObj)) {
      const rv = asRecord(raw, `members.${id}`);
      const m = new Team.Member({
        id,
        name: asOptionalString(rv.name, `members.${id}.name`) ?? id,
        provider: asOptionalString(rv.provider, `members.${id}.provider`),
        model: asOptionalString(rv.model, `members.${id}.model`),
        gofor: asOptionalStringArray(rv.gofor, `members.${id}.gofor`),
        toolsets: asOptionalStringArray(rv.toolsets, `members.${id}.toolsets`),
        tools: asOptionalStringArray(rv.tools, `members.${id}.tools`),
        model_params: asOptionalModelParams(rv.model_params, `members.${id}.model_params`),
        read_dirs: asOptionalStringArray(rv.read_dirs, `members.${id}.read_dirs`),
        write_dirs: asOptionalStringArray(rv.write_dirs, `members.${id}.write_dirs`),
        no_read_dirs: asOptionalStringArray(rv.no_read_dirs, `members.${id}.no_read_dirs`),
        no_write_dirs: asOptionalStringArray(rv.no_write_dirs, `members.${id}.no_write_dirs`),
        icon: asOptionalString(rv.icon, `members.${id}.icon`),
        streaming: asOptionalBoolean(rv.streaming, `members.${id}.streaming`),
      });
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
