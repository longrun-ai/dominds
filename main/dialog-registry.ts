/**
 * Module: dialog-registry
 *
 * Phase 13: CORRECTED - Mutex-based registry for tracking subdialogs by agentId and topicId.
 *
 * Design Principle: Registry tracks MUTEX state only (locked/unlocked).
 * It does NOT track dialog lifecycle states (active/suspended/done) - those are Dialog concerns.
 *
 * Mutex Semantics:
 * - locked: true  → Subdialog is currently being driven (mutex held)
 * - locked: false → Entry exists but subdialog is not locked (can resume)
 */

import type { DialogID } from './dialog';
import { formatUnifiedTimestamp } from './shared/utils/time';

/**
 * Entry in the subdialog mutex registry.
 * Only tracks whether the subdialog is currently being driven.
 */
export interface MutexEntry {
  /** Composite key: agentId!topicId */
  key: string;
  /** DialogID of the subdialog */
  subdialogId: DialogID;
  /** When the entry was created */
  createdAt: string;
  /** When the entry was last accessed */
  lastAccessedAt: string;
  /** Whether someone is currently driving this subdialog (mutex held) */
  locked: boolean;
}

/**
 * Mutex-based registry for tracking subdialogs by agentId and topicId.
 * Used to prevent duplicate subdialog creation and serialize LLM generations.
 */
export class SubdialogMutex {
  /** In-memory store of mutex entries keyed by composite key */
  private readonly entries: Map<string, MutexEntry> = new Map();

  /**
   * Generate a composite key from agentId and topicId.
   * Format: agentId!topicId
   */
  static makeKey(agentId: string, topicId: string): string {
    return `${agentId}!${topicId}`;
  }

  /**
   * Acquire mutex lock for a subdialog.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @param subdialogId - The DialogID of the subdialog
   * @returns The created MutexEntry
   */
  lock(agentId: string, topicId: string, subdialogId: DialogID): MutexEntry {
    const key = SubdialogMutex.makeKey(agentId, topicId);
    const now = formatUnifiedTimestamp(new Date());

    const entry: MutexEntry = {
      key,
      subdialogId,
      createdAt: now,
      lastAccessedAt: now,
      locked: true,
    };

    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Release mutex lock when subdialog completes LLM generation.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns True if mutex was released, false if entry not found
   */
  unlock(agentId: string, topicId: string): boolean {
    const key = SubdialogMutex.makeKey(agentId, topicId);
    const entry = this.entries.get(key);

    if (entry) {
      entry.locked = false;
      entry.lastAccessedAt = formatUnifiedTimestamp(new Date());
      return true;
    }

    return false;
  }

  /**
   * Check if a subdialog is currently being driven (mutex held).
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns True if the entry exists and is locked
   */
  isLocked(agentId: string, topicId: string): boolean {
    const key = SubdialogMutex.makeKey(agentId, topicId);
    return this.entries.get(key)?.locked ?? false;
  }

  /**
   * Lookup a subdialog by agentId and topicId.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns The MutexEntry if found, null otherwise
   */
  lookup(agentId: string, topicId: string): MutexEntry | null {
    const key = SubdialogMutex.makeKey(agentId, topicId);
    const entry = this.entries.get(key);

    if (entry) {
      // Update last accessed timestamp on lookup
      entry.lastAccessedAt = formatUnifiedTimestamp(new Date());
    }

    return entry ?? null;
  }

  /**
   * Get the subdialog ID for an agent/topic pair.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns The subdialog ID if found, null otherwise
   */
  getSubdialogId(agentId: string, topicId: string): DialogID | null {
    return this.lookup(agentId, topicId)?.subdialogId ?? null;
  }

  /**
   * Remove an entry from the registry.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns True if an entry was removed
   */
  remove(agentId: string, topicId: string): boolean {
    const key = SubdialogMutex.makeKey(agentId, topicId);
    return this.entries.delete(key);
  }

  /**
   * Get all entries in the registry.
   * @returns Readonly array of all mutex entries
   */
  getAll(): ReadonlyArray<MutexEntry> {
    return Array.from(this.entries.values());
  }

  /**
   * Get all locked entries (subdialogs currently being driven).
   * @returns Readonly array of locked mutex entries
   */
  getLockedEntries(): ReadonlyArray<MutexEntry> {
    return this.getAll().filter((entry) => entry.locked);
  }

  /**
   * Get all unlocked entries (subdialogs idle and resumable).
   * @returns Readonly array of unlocked mutex entries
   */
  getUnlockedEntries(): ReadonlyArray<MutexEntry> {
    return this.getAll().filter((entry) => !entry.locked);
  }

  /**
   * Clear all entries from the registry.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get the number of entries in the registry.
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * @deprecated Use SubdialogMutex instead.
 * This alias is provided for backward compatibility during migration.
 */
export type SubdialogRegistry = SubdialogMutex;

/**
 * @deprecated Use MutexEntry instead.
 * This alias is provided for backward compatibility during migration.
 */
export type RegistryEntry = MutexEntry;
