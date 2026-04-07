import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const promptCache = new Map<string, string>();
const BUILTIN_PROMPT_DIRECTIVE = '@codex-system-prompt';
const BUILTIN_PROMPT_DIRECTIVE_PATTERN =
  /^([ \t]*)@codex-system-prompt(?::([A-Za-z0-9._-]+))?([ \t]*)$/gm;

export function resolveCodexPromptFilename(model: string): string {
  if (model.startsWith('gpt-5.4')) {
    return 'gpt_5_4_prompt.md';
  }
  if (model.startsWith('gpt-5.3-codex')) {
    return 'gpt-5.3-codex_prompt.md';
  }
  if (model.startsWith('gpt-5.2-codex') || model.startsWith('bengalfox')) {
    return 'gpt-5.2-codex_prompt.md';
  }
  if (model.startsWith('gpt-5.1-codex-max')) {
    return 'gpt-5.1-codex-max_prompt.md';
  }
  if (
    (model.startsWith('gpt-5-codex') ||
      model.startsWith('gpt-5.1-codex') ||
      model.startsWith('codex-')) &&
    !model.includes('-mini')
  ) {
    return 'gpt_5_codex_prompt.md';
  }
  if (model.startsWith('codex-mini-latest')) {
    return 'prompt_with_apply_patch_instructions.md';
  }
  if (model.startsWith('gpt-5.2')) {
    return 'gpt_5_2_prompt.md';
  }
  if (model.startsWith('gpt-5.1')) {
    return 'gpt_5_1_prompt.md';
  }
  return 'prompt.md';
}

function resolvePromptUrl(filename: string): URL {
  return new URL(`../prompts/${filename}`, import.meta.url);
}

async function readPromptFile(url: URL): Promise<string | null> {
  try {
    return await readFile(url, 'utf8');
  } catch {
    return null;
  }
}

function readPromptFileSync(url: URL): string | null {
  if (!existsSync(url)) {
    return null;
  }
  return readFileSync(url, 'utf8');
}

export async function loadCodexPrompt(model: string): Promise<string | null> {
  const cached = promptCache.get(model);
  if (cached) {
    return cached;
  }

  const filename = resolveCodexPromptFilename(model);
  const candidate = resolvePromptUrl(filename);
  const prompt = await readPromptFile(candidate);
  if (prompt) {
    promptCache.set(model, prompt);
    return prompt;
  }

  const fallback = resolvePromptUrl('prompt.md');
  const fallbackPrompt = await readPromptFile(fallback);
  if (fallbackPrompt) {
    promptCache.set(model, fallbackPrompt);
    return fallbackPrompt;
  }

  return null;
}

export function loadCodexPromptSync(model: string): string | null {
  const cached = promptCache.get(model);
  if (cached) {
    return cached;
  }

  const filename = resolveCodexPromptFilename(model);
  const candidate = resolvePromptUrl(filename);
  const prompt = readPromptFileSync(candidate);
  if (prompt) {
    promptCache.set(model, prompt);
    return prompt;
  }

  const fallback = resolvePromptUrl('prompt.md');
  const fallbackPrompt = readPromptFileSync(fallback);
  if (fallbackPrompt) {
    promptCache.set(model, fallbackPrompt);
    return fallbackPrompt;
  }

  return null;
}

function resolveBundledPromptOrThrow(model: string): string {
  const prompt = loadCodexPromptSync(model);
  if (prompt === null) {
    throw new Error(`Bundled Codex prompt template not found for model: ${model}`);
  }
  return prompt;
}

export function resolveCodexPromptTemplateSync(template: string, defaultModel: string): string {
  let replaced = false;
  const resolved = template.replace(
    BUILTIN_PROMPT_DIRECTIVE_PATTERN,
    (_match: string, leading: string, overrideModel: string | undefined, trailing: string) => {
      const selectedModel = overrideModel ?? defaultModel;
      const prompt = resolveBundledPromptOrThrow(selectedModel);
      replaced = true;
      return `${leading}${prompt}${trailing}`;
    },
  );

  if (!replaced) {
    return template;
  }

  return resolved;
}

export function builtinCodexPromptDirective(model?: string): string {
  if (model === undefined || model.length === 0) {
    return BUILTIN_PROMPT_DIRECTIVE;
  }
  return `${BUILTIN_PROMPT_DIRECTIVE}:${model}`;
}
