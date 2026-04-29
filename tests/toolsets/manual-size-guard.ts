#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import {
  TEAM_MGMT_GUIDE_UI_TOOL_TOPICS_BY_KEY,
  TEAM_MGMT_GUIDE_UI_TOPIC_ORDER,
} from '@longrun-ai/kernel';

import '../../main/tools/builtins';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { MANUAL_TOPICS } from '../../main/tools/manual/spec';
import { listToolsets } from '../../main/tools/registry';
import { renderToolsetManualContent } from '../../main/tools/toolset-manual';

type ManualGuardCase = Readonly<{
  label: string;
  toolsetId: string;
  language: 'zh' | 'en';
  topic?: string;
  topics?: readonly string[];
}>;

type ManualGuardResult = Readonly<{
  label: string;
  length: number;
}>;

function buildGenericToolsetCases(): ManualGuardCase[] {
  const out: ManualGuardCase[] = [];
  for (const toolsetId of Object.keys(listToolsets()).sort()) {
    if (toolsetId === 'team_mgmt') continue;
    for (const language of ['zh', 'en'] as const) {
      out.push({
        label: `${toolsetId}/${language}/default`,
        toolsetId,
        language,
      });
      for (const topic of MANUAL_TOPICS) {
        out.push({
          label: `${toolsetId}/${language}/${topic}`,
          toolsetId,
          language,
          topic,
        });
      }
    }
  }
  return out;
}

function buildTeamMgmtCases(): ManualGuardCase[] {
  const out: ManualGuardCase[] = [];
  for (const language of ['zh', 'en'] as const) {
    out.push({
      label: `team_mgmt/${language}/default`,
      toolsetId: 'team_mgmt',
      language,
    });
    for (const uiTopic of TEAM_MGMT_GUIDE_UI_TOPIC_ORDER) {
      const topics = TEAM_MGMT_GUIDE_UI_TOOL_TOPICS_BY_KEY[uiTopic];
      assert.ok(
        topics.length > 0,
        `Expected team_mgmt UI topic '${uiTopic}' to map to tool topics`,
      );
      out.push({
        label: `team_mgmt/${language}/${uiTopic}`,
        toolsetId: 'team_mgmt',
        language,
        topics,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  // Build-time guard is intentionally scoped to statically known handbook surfaces:
  // builtin toolsets plus the builtin-rendered `team_mgmt` guide chapters.
  // Runtime-discovered app/MCP manuals depend on the actual rtws and are only bounded at runtime.
  const cases = [...buildGenericToolsetCases(), ...buildTeamMgmtCases()];
  const results: ManualGuardResult[] = [];

  for (const manualCase of cases) {
    const content = await renderToolsetManualContent({
      toolsetId: manualCase.toolsetId,
      language: manualCase.language,
      ...(manualCase.topic !== undefined ? { topic: manualCase.topic } : {}),
      ...(manualCase.topics !== undefined ? { topics: manualCase.topics } : {}),
    });
    results.push({ label: manualCase.label, length: content.length });
  }

  const violations = results
    .filter((result) => result.length > MANUAL_SINGLE_REQUEST_CHAR_LIMIT)
    .sort((a, b) => b.length - a.length);
  if (violations.length > 0) {
    const detail = violations
      .map((result) => `- ${result.label}: ${result.length} chars`)
      .join('\n');
    throw new Error(
      [
        `Manual size guard failed: single manual requests must stay within ${MANUAL_SINGLE_REQUEST_CHAR_LIMIT} chars.`,
        detail,
      ].join('\n'),
    );
  }

  const largest = [...results].sort((a, b) => b.length - a.length).slice(0, 5);
  console.log(
    [
      `OK: manual size guard passed (${results.length} request(s), limit=${MANUAL_SINGLE_REQUEST_CHAR_LIMIT}).`,
      ...largest.map((result) => `- ${result.label}: ${result.length} chars`),
    ].join('\n'),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
