#!/usr/bin/env node

/**
 * Manual subcommand for dominds CLI
 *
 * Usage:
 *   dominds man <toolsetId> [--topic <name>|--topics <a,b,c>|--all] [--lang <en|zh>]
 *   dominds man --list
 *
 * Examples:
 *   dominds man ws_read --lang zh --all
 *   dominds man team_mgmt --topics index,tools
 */

import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { FuncTool } from '../tool';
import '../tools/builtins';
import { MANUAL_TOPICS } from '../tools/manual/spec';
import { getToolset, getToolsetMeta, listToolsets } from '../tools/registry';
import { renderToolsetManualContent } from '../tools/toolset-manual';

type ParsedArgs = Readonly<{
  toolsetId?: string;
  topic?: string;
  topics?: string[];
  language: LanguageCode;
  list: boolean;
}>;

function printUsage(): void {
  console.log(
    'Usage: dominds man <toolsetId> [--topic <name>|--topics <a,b,c>|--all] [--lang <en|zh>]',
  );
  console.log('       dominds man --list');
  console.log('Alias: dominds manual ...');
  console.log('');
  console.log(
    "Note: the topic list below shows common manual topics. Some toolsets (for example `team_mgmt`) expose additional toolset-specific topic keys; run `dominds man <toolsetId> --all` to see that toolset's dedicated index.",
  );
  console.log('');
  console.log('Examples:');
  console.log('  dominds man ws_read --lang zh --all');
  console.log('  dominds man team_mgmt --topics index,tools');
  console.log('  dominds man team_mgmt --all');
  console.log('');
  console.log(`Common topics: ${MANUAL_TOPICS.join(', ')} (or 'all')`);
}

function normalizeLanguage(raw?: string): LanguageCode {
  if (!raw) return 'en';
  const value = raw.toLowerCase().trim();
  return value === 'zh' ? 'zh' : 'en';
}

function parseTopics(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let toolsetId: string | undefined;
  let topic: string | undefined;
  let topics: string[] | undefined;
  let language: LanguageCode = 'en';
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--') {
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--list') {
      list = true;
      continue;
    }

    if (arg === '--all') {
      topic = 'all';
      continue;
    }

    if (arg === '--lang' || arg === '--language') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --lang');
      }
      language = normalizeLanguage(next);
      i += 1;
      continue;
    }

    if (arg.startsWith('--lang=')) {
      language = normalizeLanguage(arg.slice('--lang='.length));
      continue;
    }

    if (arg === '--en') {
      language = 'en';
      continue;
    }

    if (arg === '--zh') {
      language = 'zh';
      continue;
    }

    if (arg === '--topic') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --topic');
      }
      topic = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--topic=')) {
      topic = arg.slice('--topic='.length);
      continue;
    }

    if (arg === '--topics') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --topics');
      }
      topics = parseTopics(next);
      i += 1;
      continue;
    }

    if (arg.startsWith('--topics=')) {
      topics = parseTopics(arg.slice('--topics='.length));
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (!toolsetId) {
      toolsetId = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { toolsetId, topic, topics, language, list };
}

function listAvailableToolsets(): void {
  const names = Object.keys(listToolsets()).sort();
  if (names.length === 0) {
    console.log('(no toolsets registered)');
    return;
  }
  console.log(`Available toolsets: ${names.map((name) => `\`${name}\``).join(', ')}`);
}

function toAvailableToolNames(toolsetId: string): Set<string> {
  const toolset = getToolset(toolsetId) ?? [];
  const names = new Set<string>();
  for (const tool of toolset) {
    if (
      tool &&
      typeof tool === 'object' &&
      'type' in tool &&
      (tool as { type: string }).type === 'func'
    ) {
      names.add((tool as FuncTool).name);
    }
  }
  return names;
}

export async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));

    if (parsed.list || !parsed.toolsetId) {
      listAvailableToolsets();
      return;
    }

    const toolsetId = parsed.toolsetId;
    if (!getToolsetMeta(toolsetId)) {
      console.error(`Error: Unknown toolset '${toolsetId}'.`);
      listAvailableToolsets();
      process.exit(1);
    }

    const availableToolNames = toAvailableToolNames(toolsetId);
    const content = await renderToolsetManualContent({
      toolsetId,
      language: parsed.language,
      topic: parsed.topic,
      topics: parsed.topics,
      availableToolNames,
    });
    console.log(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    printUsage();
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
