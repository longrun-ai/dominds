/**
 * Module: tools/registry
 *
 * Global registries for tools and toolsets with helpers and built-in initialization.
 */
import type { ReminderOwner, Tool } from '../tool';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  updateReminderTool,
} from './ctrl';
import { listDirTool, rmDirTool, rmFileTool } from './fs';
import {
  addMemoryTool,
  addSharedMemoryTool,
  clearMemoryTool,
  clearSharedMemoryTool,
  dropMemoryTool,
  dropSharedMemoryTool,
  replaceMemoryTool,
  replaceSharedMemoryTool,
} from './mem';
import { getDaemonOutputTool, shellCmdReminderOwner, shellCmdTool, stopDaemonTool } from './os';
import { applyPatchTool, overwriteFileTool, patchFileTool, readFileTool } from './txt';

// Global public registry of tools, shared across the application
export const toolsRegistry: Map<string, Tool> = new Map<string, Tool>();

// Global public registry of toolsets, shared across the application
export const toolsetsRegistry: Map<string, Tool[]> = new Map<string, Tool[]>();

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

// Initialize registry with built-in non-ask tools
(function initializeBuiltins() {
  registerTool(listDirTool);
  registerTool(rmDirTool);
  registerTool(rmFileTool);
  registerTool(readFileTool);
  registerTool(overwriteFileTool);
  registerTool(patchFileTool);
  registerTool(applyPatchTool);

  // OS tools
  registerTool(shellCmdTool);
  registerTool(stopDaemonTool);
  registerTool(getDaemonOutputTool);

  // Memory tools
  registerTool(addMemoryTool);
  registerTool(dropMemoryTool);
  registerTool(replaceMemoryTool);
  registerTool(clearMemoryTool);
  registerTool(addSharedMemoryTool);
  registerTool(dropSharedMemoryTool);
  registerTool(replaceSharedMemoryTool);
  registerTool(clearSharedMemoryTool);

  // Control tools
  registerTool(addReminderTool);
  registerTool(deleteReminderTool);
  registerTool(updateReminderTool);
  registerTool(clearMindTool);
  registerTool(changeMindTool);

  // Register well-known toolsets
  registerToolset('memory', [addMemoryTool, dropMemoryTool, replaceMemoryTool, clearMemoryTool]);
  registerToolset('team_memory', [
    addSharedMemoryTool,
    dropSharedMemoryTool,
    replaceSharedMemoryTool,
    clearSharedMemoryTool,
  ]);
  registerToolset('control', [
    addReminderTool,
    deleteReminderTool,
    updateReminderTool,
    clearMindTool,
    changeMindTool,
  ]);
  registerToolset('os', [shellCmdTool, stopDaemonTool, getDaemonOutputTool]);
  registerToolset('ws_read', [listDirTool, readFileTool]);
  registerToolset('ws_mod', [
    listDirTool,
    rmDirTool,
    rmFileTool,
    readFileTool,
    overwriteFileTool,
    patchFileTool,
    applyPatchTool,
  ]);

  // Register common aliases for backward compatibility
  registerToolset('fs', [listDirTool, rmDirTool, rmFileTool, readFileTool]);
  registerToolset('txt', [readFileTool, overwriteFileTool, patchFileTool, applyPatchTool]);

  // Register ReminderOwners
  registerReminderOwner(shellCmdReminderOwner);
})();
