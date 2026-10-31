import type { FuncResultContentItem } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MainDialog } from '../../main/dialog';
import type { ChatMessage, ProviderConfig } from '../../main/llm/client';
import { buildAnthropicRequestMessagesWrapper } from '../../main/llm/gen/anthropic';
import { buildOpenAiRequestInputWrapper } from '../../main/llm/gen/openai';
import { buildOpenAiCompatibleRequestMessagesWrapper } from '../../main/llm/gen/openai-compatible';
import { DialogPersistence } from '../../main/persistence';
import type { semanticEvidenceCollector } from './semantic-evidence';

export type ProjectionApi = 'openai' | 'openai-compatible' | 'anthropic';
type ImageItem = Extract<FuncResultContentItem, { type: 'input_image' }>;
export async function fixtureImage(dialog: MainDialog, index: number, declaredBytes?: number) {
  // One-pixel GIF with distinct palette bytes, so exact native payload equality identifies
  // which artifact was loaded. No image decoder/visual understanding is under test.
  const bytes = Buffer.from(
    '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
    'hex',
  );
  bytes[13] = index;
  const item: ImageItem = {
    type: 'input_image',
    mimeType: 'image/gif',
    byteLength: declaredBytes ?? bytes.length,
    artifact: {
      rootId: dialog.id.rootId,
      selfId: dialog.id.selfId,
      status: 'running',
      relPath: `artifacts/projection/${index}.gif`,
    },
  };
  const file = path.join(
    DialogPersistence.getDialogEventsPath(dialog.id, 'running'),
    item.artifact.relPath,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return { item, bytes, file, url: 'data:image/gif;base64,' + bytes.toString('base64') };
}
export function imageProvider(apiType: ProjectionApi, supportsImage = true): ProviderConfig {
  return {
    name: 'image-projection-fixture',
    apiType,
    baseUrl: 'https://example.invalid',
    apiKeyEnvVar: 'UNUSED_IMAGE_FIXTURE_KEY',
    models: {
      vision: { name: 'fixture-vision', supports_image_input: supportsImage },
      unknown: { name: 'fixture-unknown', supports_image_input: supportsImage },
    },
  };
}
export async function projectImages(
  api: ProjectionApi,
  context: ChatMessage[],
  supportsImage = true,
) {
  const config = imageProvider(api, supportsImage);
  const request = {
    dialogSelfId: 'projection',
    dialogRootId: 'projection',
    providerKey: api,
    modelKey: 'vision',
  };
  if (api === 'openai') return await buildOpenAiRequestInputWrapper(context, config);
  if (api === 'openai-compatible')
    return await buildOpenAiCompatibleRequestMessagesWrapper('', context, request, {
      providerConfig: config,
    });
  return await buildAnthropicRequestMessagesWrapper(context, request, config);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Read only actual native protocol image fields, never fallback prose. */
export function nativeImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nativeImageUrls);
  if (!record(value)) return [];
  if (value.type === 'input_image') {
    assert.ok(typeof value.image_url === 'string');
    return [value.image_url];
  }
  if (value.type === 'image_url') {
    assert.ok(record(value.image_url));
    assert.ok(typeof value.image_url.url === 'string');
    return [value.image_url.url];
  }
  if (value.type === 'image') {
    assert.ok(record(value.source));
    assert.equal(value.source.type, 'base64');
    assert.equal(typeof value.source.media_type, 'string');
    assert.equal(typeof value.source.data, 'string');
    return [`data:${value.source.media_type};base64,${value.source.data}`];
  }
  return Object.values(value).flatMap(nativeImageUrls);
}
/** Collect only native visible text/content/output fields, excluding IDs and arguments. */
export function projectionTextValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(projectionTextValues);
  if (!record(value)) return [];
  const texts: string[] = [];
  if ((value.type === 'input_text' || value.type === 'text') && typeof value.text === 'string')
    texts.push(value.text);
  if (value.type === 'function_call_output' && typeof value.output === 'string')
    texts.push(value.output);
  if (
    (value.type === 'message' ||
      value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'tool') &&
    typeof value.content === 'string'
  )
    texts.push(value.content);
  return [...texts, ...Object.values(value).flatMap(projectionTextValues)];
}

export function recordImageProjection(
  evidence: ReturnType<typeof semanticEvidenceCollector>,
  id: string,
  context: ChatMessage[],
  projection: unknown,
  scenario: string,
) {
  evidence.record({
    id,
    scenario,
    businessValue:
      'Keep available visual context usable and describe omitted images honestly, so an executing agent does not assume it saw an unavailable attachment.',
    context: {
      input: JSON.stringify(context),
      scope:
        'Actual local artifact reading and request projection only. No request is sent; no SDK transport, image decoding or visual reasoning is established. Budget cases use explicit declared byteLength metadata with small distinct GIF files, not an actual 60MiB payload.',
    },
    reviewQuestions: [
      'Do the actual fallback text and history distinguish the supplied missing, unsupported or over-budget image correctly, retain its source identity and avoid claiming unseen image content was analyzed?',
    ],
    actualText: JSON.stringify(projection, null, 2),
  });
}
