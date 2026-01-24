/**
 * Module: tools/registry
 *
 * Global registries for tools and toolsets with helpers and built-in initialization.
 */
import fsSync from 'fs';
import path from 'path';
import type { I18nText } from '../shared/types/i18n';
import type { ReminderOwner, Tool } from '../tool';

// Global public registry of tools, shared across the application
export const toolsRegistry: Map<string, Tool> = new Map<string, Tool>();

// Global public registry of toolsets, shared across the application
export const toolsetsRegistry: Map<string, Tool[]> = new Map<string, Tool[]>();

export type ToolsetMeta = {
  descriptionI18n?: I18nText;
  /**
   * Toolset-level prompt injected into the agent system prompt when the member
   * includes this toolset. Use this for comprehensive workflows/examples; keep
   * per-tool usage descriptions focused on the tool's own contract.
   */
  promptI18n?: I18nText;
  /**
   * Toolset-level prompt loaded from markdown files (read on-demand, no cache).
   * Paths are relative to the directory of the compiled JS module (i.e. `__dirname`).
   */
  promptFilesI18n?: Partial<Record<keyof I18nText, string>>;
};

export const toolsetMetaRegistry: Map<string, ToolsetMeta> = new Map<string, ToolsetMeta>();

// Global public registry of ReminderOwner instances, shared across the application
export const reminderOwnersRegistry: Map<string, ReminderOwner> = new Map<string, ReminderOwner>();

// Register a tool object by name
export function registerTool(tool: Tool): void {
  toolsRegistry.set(tool.name, tool);
}

// Unregister a tool by name
export function unregisterTool(name: string): void {
  toolsRegistry.delete(name);
}

// Retrieve a tool by name
export function getTool(name: string): Tool | undefined {
  return toolsRegistry.get(name);
}

// List all registered tools
export function listTools(): Tool[] {
  return Array.from(toolsRegistry.values());
}

// Register a toolset by name with a list of tool objects
export function registerToolset(name: string, tools: Tool[]): void {
  toolsetsRegistry.set(name, tools);
}

// Unregister a toolset by name
export function unregisterToolset(name: string): void {
  toolsetsRegistry.delete(name);
  toolsetMetaRegistry.delete(name);
}

export function setToolsetMeta(name: string, meta: ToolsetMeta): void {
  toolsetMetaRegistry.set(name, meta);
}

export function getToolsetMeta(name: string): ToolsetMeta | undefined {
  return toolsetMetaRegistry.get(name);
}

export function getToolsetPromptI18n(name: string): I18nText | undefined {
  const meta = getToolsetMeta(name);
  if (!meta) return undefined;
  if (meta.promptI18n) return meta.promptI18n;
  if (!meta.promptFilesI18n) return undefined;

  const enPath = meta.promptFilesI18n.en;
  const zhPath = meta.promptFilesI18n.zh;
  if (!enPath || !zhPath) return undefined;

  const tryRead = (relPath: string): string => {
    const abs = path.resolve(__dirname, relPath);
    try {
      return fsSync.readFileSync(abs, 'utf8');
    } catch {
      return '';
    }
  };

  const en = tryRead(enPath);
  const zh = tryRead(zhPath);
  if (en.trim() === '' || zh.trim() === '') return undefined;

  return { en, zh };
}

// Retrieve a toolset by name (returns array of tool objects)
export function getToolset(name: string): Tool[] | undefined {
  return toolsetsRegistry.get(name);
}

// List all registered toolsets
export function listToolsets(): Record<string, Tool[]> {
  return Object.fromEntries(toolsetsRegistry.entries());
}

// Register a ReminderOwner by unique name
export function registerReminderOwner(owner: ReminderOwner, name?: string): void {
  const ownerName = name || owner.name;
  if (!ownerName) {
    throw new Error('ReminderOwner must have a name property or name must be provided explicitly');
  }
  reminderOwnersRegistry.set(ownerName, owner);
}

// Unregister a ReminderOwner by name
export function unregisterReminderOwner(name: string): void {
  reminderOwnersRegistry.delete(name);
}

// Retrieve a ReminderOwner by name
export function getReminderOwner(name: string): ReminderOwner | undefined {
  return reminderOwnersRegistry.get(name);
}

// List all registered ReminderOwners
export function listReminderOwners(): Map<string, ReminderOwner> {
  return new Map(reminderOwnersRegistry);
}
