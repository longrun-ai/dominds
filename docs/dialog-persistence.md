# Dialog Persistence and Storage

This document describes the persistence layer and storage mechanisms for the Dominds dialog system, including file system conventions, data structures, and storage patterns.

## Current Implementation Status

The persistence layer is fully implemented and active with modern TypeScript typing and `latest.yaml` support. `main/persistence.ts` provides file-backed storage with strong type safety and real-time timestamp tracking.

### Current State

- **✅ Fully Implemented**: Modern storage system with strong TypeScript types in `main/shared/types/storage.ts`
- **✅ latest.yaml Support**: Current round and lastModified tracking for accurate UI timestamps
- **✅ Append-Only Events**: JSONL-based event streaming with atomic operations
- **✅ Strong Type Safety**: Discriminated unions and type guards for compile-time verification
- **✅ Real File I/O**: Dialog sessions persist under `.dialogs/run|done|archive` with modern file formats
- **✅ UI Integration**: WebSocket events map directly to UI with accurate timestamps from persisted records

### Key Features

- **latest.yaml**: Tracks current round, lastModified timestamps, message counts, and dialog status
- **Strong Typing**: Modern TypeScript patterns with discriminated unions and type guards
- **Atomic Operations**: All file operations are atomic to prevent corruption
- **Efficient Timestamps**: UI displays accurate lastModified times from persisted records
- **Stream-Compatible**: Append-only design supports real-time streaming and disk persistence
- **Error Filtering**: Stream errors are NOT persisted to disk files and NOT restored to UI

## Table of Contents

1. [Storage Architecture](#storage-architecture) _(Design Reference Only)_
2. [Workspace Conventions](#workspace-conventions) _(Design Reference Only)_
3. [Dialog Storage Structure](#dialog-storage-structure) _(Design Reference Only)_
4. [Memory Persistence](#memory-persistence) _(Design Reference Only)_
5. [Data Formats](#data-formats) _(Design Reference Only)_
6. [Error Persistence Policy](#error-persistence-policy) _(Design Reference Only)_
7. [Persistence Operations](#persistence-operations) _(Design Reference Only)_
8. [Completed Implementation Summary](#completed-implementation-summary)

---

## Storage Architecture

The implementation follows this architecture.

### Design Principles

- **Flat Subdialog Storage**: All subdialogs are stored flat under the main dialog's (root dialog's) `subdialogs/` directory, regardless of nesting depth
- **Append-Only Streams**: Message streams are append-only for audit trails and replay capability
- **Atomic Operations**: All persistence operations are atomic to prevent corruption
- **Human-Readable Formats**: Storage uses YAML and JSONL for transparency and debugging

### Directory Layout

```
workspace/
├── .minds/                    # Agent configuration and persistent memories
│   ├── llm.yaml              # LLM provider configuration
│   ├── team.yaml             # Team roster and default settings
│   ├── team/                 # Agent-specific configurations
│   │   └── <member>/
│   │       ├── persona.md    # Agent personality and role
│   │       ├── knowledge.md  # Agent expertise and skills
│   │       └── lessons.md    # Agent learning and adaptations
│   └── memory/               # Workspace-persistent memories
│       ├── team_shared/      # Team-shared memories (all `*.md` under this dir are loaded)
│       │   └── *.md
│       └── individual/       # Agent-individual memories (per agent)
│           └── <member>/
│               └── **/*.md
└── .dialogs/                 # Dialog runtime state
    ├── run/                  # Active dialogs
    ├── done/                 # Completed dialogs
    └── archive/              # Archived dialogs
```

---

## Workspace Conventions

These conventions guide workspace organization. Dialog directories are created dynamically under `.dialogs/`.

### Agent Configuration (`.minds/`)

**Team Configuration** (`team.yaml`):

```yaml
name: 'Development Team'
default_agent: 'alice'
default_provider: 'openai'
members:
  - id: 'alice'
    name: 'Alice'
    role: 'Senior Developer'
    provider: 'openai'
  - id: 'bob'
    name: 'Bob'
    role: 'DevOps Engineer'
    provider: 'anthropic'
```

**LLM Configuration** (`llm.yaml`):

```yaml
providers:
  openai:
    api_key_env: 'OPENAI_API_KEY'
    model: 'gpt-4'
    temperature: 0.7
  anthropic:
    api_key_env: 'ANTHROPIC_API_KEY'
    model: 'claude-3-sonnet'
    temperature: 0.5
```

**Agent Persona** (`team/<member>/persona.md`):

- Agent personality and communication style
- Role-specific responsibilities and expertise
- Collaboration preferences and patterns

**Agent Knowledge** (`team/<member>/knowledge.md`):

- Technical expertise and specializations
- Domain-specific knowledge and experience
- Tool proficiencies and preferences

**Agent Lessons** (`team/<member>/lessons.md`):

- Learning from past interactions and mistakes
- Adaptation patterns and improvements
- Performance optimizations and insights

### Memory Storage (`.minds/memory/`)

Dominds loads memory files as plain markdown (`*.md`) from two scopes:

- **Team-shared memories**: `.minds/memory/team_shared/**/*.md`
- **Individual memories**: `.minds/memory/individual/<member>/**/*.md`

These paths are enforced by the memory tools (see `main/tools/mem.ts`) and loaded into agent context by
`main/minds/load.ts`.

---

## Dialog Storage Structure _(Design Reference Only)_

> **Note**: This section describes the intended dialog storage structure, and the current persistence implementation largely matches it (see `main/persistence.ts`).

### Dialog Identification

**Dialog IDs**: Generated using `generateDialogID()` format: `aa/bb/cccccccc`

- First two segments: randomness and distribution
- Third segment: timestamp-based uniqueness
- Enables flat storage while maintaining uniqueness

**DialogID Schema**: The system uses a `self+root` ID schema implemented in the `DialogID` class:

- **selfDlgId**: The unique identifier for this specific dialog instance
- **rootDlgId**: The identifier for the root dialog in the hierarchy (defaults to selfDlgId for root dialogs)
- **Serialization**: When `rootDlgId` differs from `selfDlgId`, the full ID is formatted as `rootDlgId#selfDlgId`; otherwise, it's just `selfDlgId`

This schema enables efficient management of subdialog relationships while maintaining unique identification for each dialog instance.

### Design Rationale

The `self+root` ID schema was implemented to address several challenges in dialog management:

1. **Hierarchical Relationship Tracking**: Provides clear lineage information for each dialog, making it easy to trace subdialogs back to their root dialog
2. **Efficient Storage Organization**: Allows for flat storage of subdialogs while preserving relationship information
3. **Unique Identification**: Ensures each dialog instance has a unique identifier, even when multiple subdialogs exist
4. **Simplified Persistence**: Enables straightforward serialization and deserialization of dialog relationships
5. **Improved Debugging**: Provides clear identification in logs and debugging information
6. **Scalability**: Supports deep subdialog hierarchies without complex storage structures

This design balances the need for clear hierarchical relationships with efficient storage and retrieval operations.

### Active Dialog Structure

```
.dialogs/run/<rootDialogId>/
├── dialog.yaml               # Dialog metadata with strong typing
├── latest.yaml               # Current round and lastModified tracking
├── reminders.json            # Persistent reminders
├── <round>.jsonl             # Streamed messages for each round
├── <round>.yaml              # Round metadata
└── subdialogs/               # Flat subdialog storage
    ├── <subDialogId1>/       # First-level subdialog
    │   ├── dialog.yaml       # Subdialog metadata
    │   ├── latest.yaml       # Subdialog current state
    │   ├── reminders.json    # Subdialog reminders
    │   ├── <round>.jsonl     # Subdialog events
    │   └── <round>.yaml      # Subdialog round metadata
    └── <subDialogId2>/       # Another subdialog
        ├── dialog.yaml
        ├── latest.yaml
        ├── reminders.json
        ├── <round>.jsonl
        └── <round>.yaml
```

**Key Features**:

- **latest.yaml**: Modern tracking file with current round, lastModified, and status
- **Strong Typing**: All files use TypeScript interfaces from `main/shared/types/storage.ts`
- **Atomic Updates**: latest.yaml updated atomically on all dialog modifications
- **UI Integration**: Timestamps from latest.yaml display correctly in dialog list

In this structure:

- Root dialogs have `selfDlgId` equal to `rootDlgId`
- Subdialogs have distinct `selfDlgId` values with the same `rootDlgId` as their parent
- Subdialog directories use only the `selfDlgId` for file system organization
- Metadata stores only the `selfDlgId`; full `rootDlgId#selfDlgId` is reconstructed during loading
- The full `rootDlgId#selfDlgId` format is used for in-memory identification and operations

### Dialog Metadata (`dialog.yaml`)

Modern strongly-typed dialog metadata using TypeScript interfaces:

#### Root Dialog Example

```yaml
id: 'aa/bb/cccccccc' # Unique dialog identifier (selfDlgId only)
agentId: 'alice' # Agent responsible for this dialog
taskDocPath: 'task.tsk' # Path to the task doc package directory
createdAt: '2024-01-15T10:30:00Z' # ISO timestamp when created
# No parent fields for root dialogs
```

#### Subdialog Example

```yaml
id: 'dd/ee/ffffffff' # Unique dialog identifier (selfDlgId only)
agentId: 'bob' # Agent responsible for this dialog
taskDocPath: 'task.tsk' # Path to task doc package directory (inherited from parent)
createdAt: '2024-01-15T10:35:00Z' # ISO timestamp when created
supdialogId: 'aa/bb/cccccccc' # Parent dialog's selfDlgId
assignmentFromSup: # Assignment context from parent
  headLine: 'Implement user authentication'
  callBody: 'Create secure login system with JWT tokens'
  originMemberId: 'alice'
```

**Type Safety**: All metadata follows `DialogMetadataFile` interface from `main/shared/types/storage.ts` with compile-time verification.

### Latest Status File (`latest.yaml`)

Modern tracking file for current dialog state and UI timestamps:

```yaml
currentRound: 3 # Current round number (1-based)
lastModified: '2024-01-15T11:45:00Z' # ISO timestamp of last activity
messageCount: 12 # Total messages in current round
functionCallCount: 3 # Total function calls in current round
subdialogCount: 1 # Total subdialogs created
status: 'active' # Current dialog status
```

**Automatic Updates**: `latest.yaml` is automatically updated on:

- New message events
- Round transitions
- Function call results
- Subdialog creation
- Any dialog modification

**UI Integration**: Dialog list displays `lastModified` timestamp from this file for accurate sorting and display.

### Round Tracking (`round.curr`)

Simple text file containing the current round number:

```
3
```

### Reminder Storage (`reminders.json`)

```json
{
  "reminders": [
    {
      "id": "r1",
      "content": "Remember to validate input parameters",
      "created_at": "2024-01-15T10:45:00Z",
      "priority": "high"
    },
    {
      "id": "r2",
      "content": "Consider edge cases for empty datasets",
      "created_at": "2024-01-15T11:00:00Z",
      "priority": "medium"
    }
  ]
}
```

---

## Memory Persistence

Reminder and questions-for-human persistence are implemented. Team-shared `.minds/` memories are managed separately and not covered by dialog persistence.

### Team-Shared Memory Synchronization

**Update Pattern**:

1. Agent detects need for shared memory update
2. Atomic write to temporary file
3. Atomic rename to replace existing file
4. Broadcast notification to other active dialogs
5. Other dialogs reload shared memory on next access

**Conflict Resolution**:

- Last-writer-wins for simple updates
- Human intervention for complex conflicts
- Version tracking for audit trails

### Agent-Individual Memory Management

**Persistence Triggers**:

- End of dialog sessions
- Significant learning events
- Periodic checkpoints during long dialogs
- Manual save operations

**Storage Format**:

- Markdown files for human readability
- JSON metadata for structured data
- Append-only logs for learning history

---

## Data Formats

These formats are actively used by the implementation.

### Message Stream Format (`.jsonl`)

Each line contains a single message in JSON format. **Note: Stream error events are NOT persisted to JSONL files.**

```jsonl
{"type": "user", "content": "Implement user authentication", "timestamp": "2024-01-15T10:30:00Z"}
{"type": "assistant", "content": "I'll help you implement user authentication. Let me start by...", "timestamp": "2024-01-15T10:30:15Z"}
{"type": "function_call", "name": "create_file", "arguments": {"path": "auth.py", "content": "..."}, "timestamp": "2024-01-15T10:30:30Z"}
{"type": "function_result", "name": "create_file", "result": {"success": true}, "timestamp": "2024-01-15T10:30:31Z"}
# Note: dlg_stream_error events are filtered out and NOT written to JSONL files
```

### Round Metadata (`.yaml`)

```yaml
round: 3
started_at: '2024-01-15T11:30:00Z'
completed_at: '2024-01-15T11:45:00Z'
message_count: 12
function_calls: 3
subdialogs_created: 1
status: 'completed'
```

### Task Document Storage

Task docs are workspace artifacts that exist independently and are referenced by dialogs through paths.
Task docs MUST be encapsulated task packages (`*.tsk/`).

```yaml
# In dialog.yaml
task_document: 'tasks/user-auth.tsk' # Path to workspace task package directory
task_document_version: 5
task_document_checksum: 'sha256:abc123...'
```

**Key Properties**:

- Task docs are standard workspace artifacts, not dialog-specific storage
- Multiple dialogs can reference the same task doc for collaborative work
- Task documents persist throughout the DevOps lifecycle, beyond individual conversations
- Changes to task document files are immediately visible to all referencing dialogs

### Error Persistence Policy

**Stream errors are NOT persisted to disk files and NOT restored to UI:**

- **No Disk Persistence**: Stream error events (`dlg_stream_error`) are NOT written to `round-*.jsonl` files
- **No UI Restoration**: Error sections (`.error-section`) appear only during active streaming and are NOT restored when dialogs are reloaded from disk
- **Log-Only**: Error details appear in backend logs (`logs/backend-stdout.log`) for debugging but are excluded from persistent storage
- **Transient UI State**: Error sections in generation bubbles are transient UI elements that disappear on dialog reload

**Rationale**:

- Prevents error state pollution in persistent dialog history
- Maintains clean dialog restoration without error artifacts
- Aligns with the principle that errors are runtime events, not part of dialog content
- Reduces storage overhead by excluding transient error data

**Implementation Notes**:

- Backend filters out `dlg_stream_error` events before writing to `round-*.jsonl`
- Frontend treats error sections as ephemeral UI state, not persisted content
- Dialog reload reconstructs only persisted content (user messages, thinking, saying, code blocks)
- Error handling remains functional during active streaming sessions

---

## Persistence Operations

The following operations are implemented.

### Dialog Creation

1. Generate unique dialog ID using `generateDialogID()`
2. Create `DialogID` instance with `selfDlgId` and `rootDlgId` (rootDlgId defaults to selfDlgId for root dialogs)
3. Create dialog directory structure
4. Write initial `dialog.yaml` metadata with the serialized DialogID
5. Initialize `round.curr` to 1
6. Create empty `reminders.json`
7. Set task document file path reference

### Message Persistence

1. Append message to current round's `.jsonl` file
2. Update round metadata if round is complete
3. Increment round counter if starting new round
4. Ensure atomic writes to prevent corruption

### Subdialog Creation

1. Generate unique subdialog ID using `generateDialogID()`
2. Create `DialogID` instance with:
   - `selfDlgId`: the newly generated subdialog ID
   - `rootDlgId`: inherited from the supdialog's `rootDlgId`
3. Create subdialog directory under parent's `subdialogs/` (using only `selfDlgId` for directory name)
4. Set task document file path reference from parent
5. Set parent call context in metadata
6. Initialize subdialog state, storing only `selfDlgId` in metadata
7. The full `DialogID` with `rootDlgId` is reconstructed during loading based on directory structure

### Dialog Completion

1. Update dialog status to "completed"
2. Finalize all round metadata
3. For root dialogs:
   - Move dialog directory from `run/` to `done/`
   - Include all subdialogs in the move
4. For subdialogs:
   - Update status in metadata
   - Notify supdialog of completion using the full serialized DialogID
5. Archive old dialogs based on retention policy

### Memory Updates

1. Load current memory state
2. Apply updates atomically
3. Write to temporary file
4. Atomic rename to replace original
5. Notify other dialogs of changes
6. Update version tracking

### Backup and Recovery

**Backup Strategy**:

- Regular snapshots of entire `.minds/` and `.dialogs/` trees
- Incremental backups of active dialogs
- Export capabilities for long-term archival

**Recovery Procedures**:

- Restore from most recent consistent snapshot
- Replay message streams to recover state
- Validate dialog hierarchy integrity
- Rebuild indexes and metadata if needed

---

## Performance Considerations

### Storage Optimization

**Flat Subdialog Storage**: Prevents deep directory nesting that can impact filesystem performance.

**Append-Only Streams**: Optimizes for write performance and enables efficient streaming.

**Lazy Loading**: Dialog content loaded on-demand to minimize memory usage.

**Compression**: Old dialog archives can be compressed to save space.

### Scalability

**Sharding**: Large workspaces can shard dialogs across multiple directories.

**Cleanup Policies**: Automatic cleanup of old completed dialogs based on age and size.

**Index Management**: Maintain indexes for fast dialog lookup and search.

### Reliability

**Atomic Operations**: All file operations are atomic to prevent corruption.

**Checksums**: File integrity verification using checksums.

**Redundancy**: Critical data can be replicated across multiple storage locations.

**Monitoring**: Health checks and alerts for storage system issues.

---

## Migration and Versioning

Migration and versioning features are not yet implemented and remain planned capabilities.

### Schema Evolution

**Version Tracking**: All storage formats include version numbers for migration support.

**Backward Compatibility**: New versions maintain compatibility with older formats.

**Migration Tools**: Automated tools for upgrading storage formats.

### Data Migration

**Export/Import**: Tools for moving dialogs between workspaces.

**Format Conversion**: Convert between different storage formats as needed.

**Validation**: Verify data integrity during migration operations.

---

## Completed Implementation Summary

### Full Refactoring Completed ✅

The persistence layer has been **completely modernized** with no backward compatibility:

#### ✅ Strong TypeScript Types (`main/shared/types/storage.ts`)

- **Modern Discriminated Unions**: Type-safe event handling with compile-time verification
- **Type Guards**: Runtime validation of storage formats
- **Generic Interfaces**: Reusable types for dialog metadata, events, and UI data
- **Strict Typing**: All field access is statically verifiable

#### ✅ latest.yaml Support

- **Real-time Tracking**: Current round and lastModified timestamps
- **Atomic Updates**: Automatically updated on all dialog modifications
- **UI Integration**: Dialog list displays accurate timestamps from persisted records
- **Status Management**: Tracks dialog status, message counts, and subdialog counts

#### ✅ Modern Persistence Layer (`main/persistence.ts`)

- **Type-Safe Operations**: All methods use strong TypeScript interfaces
- **Atomic File Operations**: All writes use temporary files + rename pattern
- **Automatic Timestamps**: latest.yaml updated automatically on events
- **Unified APIs**: Consistent interface for root dialogs and subdialogs

#### ✅ Updated API Layer (`main/server/api-routes.ts`)

- **Timestamp Integration**: API responses include lastModified from latest.yaml
- **Type-Safe Responses**: Strong typing for all API endpoints
- **Efficient Queries**: Load latest.yaml alongside metadata for complete state

#### ✅ UI Timestamp Display

- **Accurate Timestamps**: Dialog list shows real lastModified from persisted records
- **Format Handling**: Existing timestamp formatting works with ISO strings
- **Real-time Updates**: UI reflects changes immediately through WebSocket events

### Migration Notes

**Breaking Changes**: This refactoring intentionally removed all backward compatibility:

- Old interfaces removed from `main/persistence.ts`
- New `main/shared/types/storage.ts` provides all type definitions
- All dialog creation now includes `latest.yaml` initialization
- API responses include `lastModified` field for UI timestamps

**Benefits Achieved**:

- Compile-time type safety for all storage operations
- Accurate UI timestamps from persisted records
- Modern TypeScript patterns throughout the codebase
- Clear separation of concerns with dedicated storage types
- Atomic file operations prevent data corruption

**Smart Caching Layer**:

- **Pros**: Reduces disk I/O, improves response times, maintains file-based benefits
- **Implementation**: In-memory caching with write-through/write-back strategies

### Improved File/Directory Organization

The redesigned file organization should support both streaming and restoration modes efficiently:

#### Proposed Directory Structure

```
workspace/
├── dialogs/
│   ├── active/           # Currently streaming dialogs
│   │   ├── {root-dialog-id}/    # Root dialog directory (selfDlgId = rootDlgId)
│   │   │   ├── stream.jsonl      # Append-only message stream
│   │   │   ├── metadata.yaml     # Dialog configuration and state
│   │   │   ├── checkpoints/      # Periodic state snapshots
│   │   │   ├── temp/             # Temporary files during streaming
│   │   │   └── subdialogs/       # Subdialog storage
│   │   │       └── {sub-dialog-id}/  # Subdialog directory (uses only selfDlgId)
│   │   │           ├── stream.jsonl
│   │   │           ├── metadata.yaml
│   │   │           └── checkpoints/
│   │   └── index.json            # Fast lookup for active dialogs
│   ├── archived/         # Completed/paused dialogs
│   │   ├── {date}/              # Organized by completion date
│   │   │   ├── {root-dialog-id}.tar.gz  # Compressed dialog archive with subdialogs
│   │   │   └── metadata.json       # Archive metadata
│   │   └── index.json            # Archive lookup index
│   └── templates/        # Dialog templates and presets
├── agents/              # Agent configurations (unchanged)
└── knowledge/           # Knowledge base (unchanged)
```

In this proposed structure:

- Root dialogs are organized by their `root-dialog-id`
- Subdialogs are stored within their root dialog's `subdialogs/` directory, using only their `selfDlgId` for directory names
- Metadata stores only the `selfDlgId` in the `id` field
- The full `rootDlgId#selfDlgId` format is reconstructed during loading and used in indexes for efficient lookup

#### File Format Specifications

- **stream.jsonl**: One JSON object per line for each message/event
- **metadata.yaml**: Human-readable configuration and state information, storing only `selfDlgId` in the `id` field
- **checkpoints/**: Binary snapshots for fast restoration of large dialogs
- **index.json**: Lightweight lookup tables with dialog metadata, including full `rootDlgId#selfDlgId` format for efficient lookup
- **Archives**: Compressed storage for completed dialogs with fast search capability

#### Phase 3: Stream-Disk Unification

1. **Unified Session Interface**: Implement common abstraction for streaming and restored sessions
2. **Incremental Persistence**: Design streaming-compatible persistence that doesn't block dialog flow
3. **Lazy Loading**: Implement efficient partial loading for large dialog histories
4. **State Synchronization**: Ensure consistency between in-memory streams and disk state
5. **Performance Optimization**: Minimize I/O overhead while maintaining data integrity

#### Phase 4: Advanced File Operations

1. **Atomic Writes**: Ensure file operations are atomic to prevent corruption
2. **Compression**: Implement efficient compression for large dialog archives
3. **Indexing**: Create file-based indexes for fast dialog lookup and search
4. **Cleanup**: Automated cleanup of temporary files and old dialog data

### Unified Streaming/Loading Architecture

The key innovation is creating a **seamless interface** between streaming and disk-based sessions:

#### Session Lifecycle Management

- **Creation**: New sessions start in streaming mode with background persistence
- **Restoration**: Disk sessions are loaded incrementally to appear as active streams
- **Transition**: Sessions can move between streaming and persisted states transparently
- **Cleanup**: Proper cleanup of resources when sessions end or are archived

#### Stream-Compatible File Formats

- **Append-Only Logs**: Message streams that can be read incrementally
- **Checkpoint Files**: Periodic snapshots for fast session restoration
- **Metadata Streams**: Separate streams for dialog metadata and state changes
- **Index Files**: Fast lookup tables for efficient session navigation

### Technical Considerations

#### File-Based State Management

- **Incremental Writes**: Append-only operations to minimize file system overhead
- **Streaming Reads**: Read files incrementally without loading entire contents into memory
- **Atomic Operations**: Use temporary files and atomic renames for consistency
- **File Locking**: Handle concurrent access to dialog files safely

#### Performance Optimization

- **Buffered I/O**: Use appropriate buffer sizes for file operations
- **Lazy Loading**: Load dialog content on-demand rather than eagerly
- **Caching Strategy**: Cache frequently accessed dialog metadata and recent messages
- **Index Management**: Maintain lightweight indexes for fast dialog discovery

#### File System Reliability

- **Error Recovery**: Handle file system errors gracefully with retry logic
- **Corruption Detection**: Use checksums to detect and handle file corruption
- **Backup Strategy**: Regular backups of critical dialog data
- **Cleanup Policies**: Automatic cleanup of temporary and obsolete files

### Integration Requirements

#### Dialog System Integration

- **Minimal Interface Changes**: Preserve existing method signatures where possible
- **Backward Compatibility**: Support existing dialog code without major refactoring
- **Performance Transparency**: Persistence should not significantly impact dialog performance

#### Development Workflow

- **Testing Strategy**: Unit tests, integration tests, and performance benchmarks
- **Development Environment**: Local development setup with minimal dependencies
- **Deployment**: Production deployment with monitoring and rollback capabilities

### Success Criteria

A successful persistence implementation should achieve:

1. **Reliable Session Restoration**: Dialog sessions can be accurately restored from persisted state
2. **Performance Targets**: Sub-100ms latency for common operations, support for 100+ concurrent dialogs
3. **Data Integrity**: Zero data loss under normal operation, graceful degradation under failure
4. **Operational Simplicity**: Easy deployment, monitoring, and maintenance
5. **Developer Experience**: Clear APIs, good error messages, comprehensive documentation

### Migration Strategy

When evolving the persistence layer:

1. **Feature Flags**: Use feature flags to gradually enable new persistence features
2. **Data Migration**: Tools to migrate any existing data to new format
3. **Rollback Plan**: Define operational rollback in case of failure
4. **Performance Testing**: Thorough testing under realistic load conditions
