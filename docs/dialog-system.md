# Dominds Dialog System Implementation

This document provides detailed implementation specifications for the Dominds dialog system, including core tools, technical architecture, dialog management, memory management, system integration, and the Questions for Human (Q4H) mechanism.

## Table of Contents

1. [Terminology](#terminology)
2. [Backend-Driven Architecture](#backend-driven-architecture)
3. [3-Type Teammate Call Taxonomy](#3-type-teammate-call-taxonomy)
4. [Core Mechanisms](#core-mechanisms)
5. [Q4H: Questions for Human](#q4h-questions-for-human)
6. [Dialog Hierarchy & Subdialogs](#dialog-hierarchy--subdialogs)
7. [Mental Clarity Tools](#mental-clarity-tools)
8. [Reminder Management](#reminder-management)
9. [Subdialog Registry](#subdialog-registry)
10. [Technical Architecture](#technical-architecture)
11. [Dialog Management](#dialog-management)
12. [Memory Management](#memory-management)
13. [System Integration](#system-integration)
14. [State Diagrams](#state-diagrams)
15. [Complete Flow Reference](#complete-flow-reference)

---

## Terminology

### Supdialog

A **supdialog** (short for "super dialog") is the parent dialog in a hierarchical dialog relationship. It orchestrates and manages subdialogs, providing context, objectives, and guidance while receiving results, questions, and escalations from its subdialogs. The supdialog maintains the overall task context and determines when subdialogs are no longer needed.

A supdialog may receive **supdialog calls** from its subdialogs during their task execution. When a subdialog needs guidance or additional context, it can call back to the supdialog, which provides responses that feed back into the subdialog's context.

### Subdialog

A **subdialog** is a specialized dialog spawned by a supdialog to handle specific subtasks. Subdialogs operate with fresh context, focusing on targeted objectives while maintaining a communication link back to their supdialog.

**Supdialog Calls**: A subdialog can call its supdialog to request clarification during task execution. This allows the subdialog to ask questions and receive guidance while maintaining its own context and progress.

### Main Dialog (Root Dialog)

The **main dialog** (also called **root dialog**) is the top-level dialog in a dialog hierarchy, with no supdialog relationship. It serves as the main entry point for task execution and can spawn multiple levels of subdialogs. These terms are used interchangeably throughout the system.

### Q4H (Questions for Human)

A **Q4H** is a pending question raised by a dialog (main or subdialog) that requires human input to proceed. Q4Hs are indexed in the dialog's `q4h.yaml` file (an index, not source of truth) and are **cleared by `@clear_mind` and `@change_mind` operations**. The actual question content is stored in the dialog's conversation messages where `@human` was called.

### Subdialog Index (subdlg.yaml)

A **subdlg.yaml** file indexes pending subdialogs that a parent dialog is waiting for. Like `q4h.yaml`, it is an index file, not the source of truth:

- The index tracks which subdialog IDs the parent is waiting for
- Actual subdialog state is verified from disk (done/ directory)
- Used by the backend coroutine for crash recovery and auto-revive

### Subdialog Registry

The **subdialog registry** is a root dialog-scoped Map that maintains persistent references to registered subdialogs. The registry uses `agentId!topicId` as its key format and is never deleted during the dialog lifecycle. It moves with the root to `done/` when the root completes, and is rebuilt on root load by scanning done/ subdialog YAMLs.

### Teammate Call

A **teammate call** is a texting tool invocation that triggers communication with another agent or subdialog. Teammate calls have three distinct patterns with different semantics (see Section 3).

---

## Backend-Driven Architecture

### Core Design Principle

Dialog driving is a **sole backend algorithm**. The frontend/client never drives dialogs. All dialog state transitions, resumption logic, and generation loops execute entirely in backend coroutines. Frontend only subscribes to publish channels (PubChan) for real-time UI updates.

### Registry Hierarchy

The system maintains three levels of registries for dialog management:

**Global Registry (Server-Scoped)**
A server-wide mapping of `rootId → RootDialog` objects. This is the single source of truth for all active root dialogs. Backend coroutines scan this registry to find dialogs needing driving.

**Local Registry (Per RootDialog)**
A per-root mapping of `selfId → Dialog` objects. This registry contains the root dialog itself plus all loaded subdialogs, enabling O(1) lookup of any dialog within a hierarchy.

**Subdialog Registry (Per RootDialog)**
A per-root mapping of `agentId!topicId → Subdialog` objects. This registry tracks TYPE B registered subdialogs for resumption across multiple interactions. TYPE C transient subdialogs are never registered.

### Per-Dialog Mutex

Each Dialog object carries an exclusive mutex with an associated wait queue. When a backend coroutine needs to drive a dialog, it first acquires the mutex. If the dialog is already locked, the coroutine enqueues its promise and waits until the mutex is released. This ensures only one coroutine drives a dialog at any moment, preventing race conditions and ensuring consistent state.

### Backend Coroutine Driving Loop

Backend coroutines drive dialogs using the following pattern:

1. Scan the Global Registry to identify root dialogs needing driving
2. For each candidate, check resumption conditions (Q4H answered, subdialog completions received)
3. Acquire the dialog's mutex before driving
4. Execute the generation loop until suspension point or completion
5. Release the mutex
6. Persist all state changes to storage

The driving loop continues until a dialog suspends (awaiting Q4H or subdialog) or completes. When conditions change (user answers Q4H, subdialog finishes), the backend detects these via storage checks and resumes driving automatically.

### Frontend Integration

Frontend clients never drive dialogs. Instead, they:

- Subscribe to the current dialog's PubChan for real-time updates
- Receive events for messages, state changes, and UI indicators
- Send user input via API endpoints (drive_dlg_by_user_msg, drive_dialog_by_user_answer)

All driving logic, resumption decisions, and state management remain purely backend concerns.

### State Persistence

Dialog state is persisted to storage at key points:

- After each message generation
- On suspension (Q4H raised, subdialog created)
- On resumption (Q4H answered, subdialog completed)
- On completion

This ensures crash recovery and enables the backend to resume from any persisted state without depending on frontend state.

---

## 3-Type Teammate Call Taxonomy

This section documents the three distinct types of teammate calls in the Dominds system, their syntax, behaviors, and use cases.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TEAMMATE CALL DECISION TREE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   LLM emits @mention                                                     │
│         │                                                                │
│         ▼                                                                │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │  Is the target the current dialog's supdialog?                  │      │
│   │  (the agentId matches subdialog.supdialog.agentId)              │      │
│   └─────────────────────────────────────────────────────────────────┘      │
│         │                              │                                   │
│        YES                             NO                                  │
│         │                              │                                   │
│         ▼                              ▼                                   │
│   ┌─────────────────────┐      ┌─────────────────────────────────┐          │
│   │  TYPE A: SUPDIALOG  │      │  Is !topic present?             │          │
│   │  CALL               │      │  (syntax: @agentId !topic X)    │          │
│   │                     │      └─────────────────────────────────┘          │
│   │  @<supdialogAgentId>│            │                    │                 │
│   │  (NO !topic)        │           YES                   NO                │
│   │                     │            │                    │                 │
│   └──────────┬──────────┘            ▼                    ▼                 │
│              │               ┌────────────────┐  ┌────────────────┐        │
│              │               │ TYPE B:        │  │ TYPE C:        │        │
│              │               │ REGISTERED     │  │ TRANSIENT      │        │
│              │               │ SUBDIALOG CALL │  │ SUBDIALOG CALL │        │
│              │               │                │  │                │        │
│              │               │ @agentId       │  │ @<nonSupdialog │        │
│              │               │ !topic <topic> │  │ agentId>       │        │
│              │               │                │  │ (NO !topic)    │        │
│              │               └───────┬────────┘  └───────┬────────┘        │
│              │                       │                   │                 │
│              │                       ▼                   ▼                 │
│              │              ┌────────────────┐  ┌────────────────┐        │
│              │              │ Registry lookup│  │ Suspend parent │        │
│              │              │ Key: agentId!  │  │ Create NEW     │        │
│              │              │ topicId        │  │ subdialog      │        │
│              │              │                │  │ Drive it       │        │
│              │              ├────────────────┤  │ NOT registered │        │
│              │              │ Exists?        │  │                │        │
│              │              ├────────────────┤  │                │        │
│              │              │ YES            │  └────────────────┘        │
│              │              │ ↓              │                            │
│              │              │ Resume         │                            │
│              │              │ subdialog      │                            │
│              │              ├────────────────┤                            │
│              │              │ NO             │                            │
│              │              │ ↓              │                            │
│              │              │ Create +       │                            │
│              │              │ Register       │                            │
│              │              └────────────────┘                            │
│              │                                                          │
│              │  Subdialog suspends                                        │
│              │  Driver drives supdialog                                  │
│              │  Response resumes subdialog                               │
│              │                                                          │
│              ▼                                                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### TYPE A: Supdialog Call

**Syntax**: `@<supdialogAgentId>` (NO `!topic`)

**Behavior**:

1. Current subdialog **suspends**
2. Driver switches to drive the **supdialog** (using `subdialog.supdialog` reference)
3. Supdialog response flows back to the subdialog
4. Subdialog **resumes** with supdialog's response in context

**Key Characteristics**:

- Uses `subdialog.supdialog` reference (no registry lookup)
- No registration - supdialog relationship is inherent
- Supdialog is always the direct parent in the hierarchy

**Example**:

```
Current dialog: sub-001 (agentId: "backend-dev")
Parent supdialog: "orchestrator" (agentId)

LLM emits: @orchestrator How should I handle the database migration?

Result:
- sub-001 suspends
- Driver drives orchestrator with the question
- orchestrator responds with guidance
- sub-001 resumes with orchestrator's response
```

### TYPE B: Registered Subdialog Call

**Syntax**: `@<anyAgentId> !topic <topic-id>` (note the space before `!topic`)

**Topic ID Schema**: `<topic-id>` uses the same identifier schema as `<mention-id>`:
`[a-zA-Z][a-zA-Z0-9_-]*`. Parsing stops at whitespace or punctuation; any trailing
headline text is ignored for topic ID parsing.

**Registry Key**: `agentId!topicId`

**Behavior**:

1. Check registry for existing subdialog with key `agentId!topicId`
2. **If exists**: Resume the registered subdialog
3. **If not exists**: Create NEW subdialog AND register it with key `agentId!topicId`
4. Parent dialog **suspends** while subdialog runs
5. Subdialog response flows back to parent
6. Parent **resumes** with subdialog's response

**Current Caller Tracking (important for reuse):**

When a registered subdialog is called again (same `agentId!topicId`), the caller can be a **different
dialog** (root or another subdialog). On every Type B call, the subdialog’s metadata is updated with:

- The **current caller dialog ID** (so responses route back to the _latest_ caller)
- The **call info** (headline/body, origin role, origin member, callId)

This makes Type B subdialogs reusable across multiple call sites without losing correct response routing.

**Call Context on Resume**:

- On every TYPE B call (new or resumed), the parent-provided `headLine`/`callBody`
  is appended to the subdialog as a new user message before the subdialog is driven.
  This ensures the subdialog receives the latest request context for each call.
- System-injected resume prompts are context only and are **not parsed** for teammate/tool calls.

**Key Characteristics**:

- Registry lookup is performed on each call
- Enables **resumption** of previous subdialogs
- Registered subdialogs persist in the registry until root completion
- Registry is root-dialog scoped (not accessible to subdialogs)

**Example**:

```
Root dialog: orchestrator
Registry: {} (empty)

LLM emits: @researcher !topic market-analysis

Result (first call):
- Registry lookup: no "researcher!market-analysis" exists
- Create new subdialog "researcher!market-analysis"
- Register it in root's registry
- orchestrator suspends
- Drive researcher subdialog
- Response flows back to orchestrator
- orchestrator resumes

LLM emits again: @researcher !topic market-analysis

Result (second call):
- Registry lookup: "researcher!market-analysis" exists
- Resume existing subdialog
- orchestrator suspends
- Drive existing researcher subdialog from where it left off
- Response flows back to orchestrator
- orchestrator resumes
```

### TYPE C: Transient Subdialog Call

**Syntax**: `@<nonSupdialogAgentId>` (NO `!topic`)

**Behavior**:

1. Current dialog **suspends**
2. Create **NEW subdialog** with the specified agentId
3. Drive the new subdialog (it is FULL-FLEDGED - can make supcalls, teammate calls, tool calls)
4. Subdialog response flows back to parent
5. Parent **resumes** with subdialog's response

**Key Characteristics**:

- **No registry lookup** - always creates a new subdialog
- **Not registered** - no persistence across calls
- The subdialog itself is fully capable (can make supcalls, teammate calls, tool calls)
- Only difference from TYPE B: no registry lookup/resume capability
- Used for one-off, independent tasks

**Example**:

```
Current dialog: orchestrator

LLM emits: @code-reviewer Please review this PR

Result:
- orchestrator suspends
- Create NEW subdialog with agentId "code-reviewer"
- Drive the code-reviewer subdialog (it can make its own calls, tools, etc.)
- code-reviewer completes with review findings
- orchestrator resumes with review in context

LLM emits again: @code-reviewer Review this other PR

Result:
- orchestrator suspends
- Create ANOTHER NEW subdialog (not the same as before!)
- Drive the new code-reviewer subdialog
- orchestrator resumes with new review in context
```

### Comparison Summary

| Aspect                     | TYPE A: Supdialog Call            | TYPE B: Registered Subdialog      | TYPE C: Transient Subdialog       |
| -------------------------- | --------------------------------- | --------------------------------- | --------------------------------- |
| **Syntax**                 | `@<supdialogAgentId>`             | `@<anyAgentId> !topic <id>`       | `@<nonSupdialogAgentId>`          |
| **!topic**                 | Not allowed                       | Required                          | Not allowed                       |
| **Registry Lookup**        | No (uses `subdialog.supdialog`)   | Yes (`agentId!topicId`)           | No (never registered)             |
| **Resumption**             | No (supdialog not a subdialog)    | Yes (lookup finds existing)       | No (always new)                   |
| **Registration**           | Not applicable                    | Created AND registered            | Never registered                  |
| **Parent Behavior**        | Subdialog suspends                | Parent suspends                   | Parent suspends                   |
| **Subdialog Capabilities** | Full (supcalls, teammates, tools) | Full (supcalls, teammates, tools) | Full (supcalls, teammates, tools) |
| **Use Case**               | Clarification from parent         | Resume persistent subtask         | One-off independent task          |

---

## Core Mechanisms

The Dominds dialog system is built on four interconnected core mechanisms that work together to provide a robust, human-in-the-loop AI collaboration environment:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CORE MECHANISMS INTERCONNECTION                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────┐                         ┌─────────────────────┐    │
│  │   Dialog Hierarchy  │◄───────────────────────►│  Subdialog Supply   │    │
│  │   (Supdialog/       │    Parent-Child         │  Mechanism          │    │
│  │    Subdialog)       │    Communication        │  (+ Registry)       │    │
│  └─────────┬───────────┘                         └──────────┬──────────┘    │
│            │                                                │               │
│            │                        ┌───────────────────────▼               │
│            │                        │                                     │
│            ▼                        ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐       │
│  │                    Q4H (Questions for Human)                    │       │
│  │   - Records questions from any dialog in hierarchy              │       │
│  │   - Cleared by @clear_mind/@change_mind                         │       │
│  │   - UI notified via questions_count_update event                │       │
│  │   - User selects question to answer                             │       │
│  └─────────────────────────────────────────────────────────────────┘       │
│            │                                                             │
│            │                        ┌───────────────────────▲               │
│            ▼                        ▼                       │               │
│  ┌─────────────────────┐   ┌─────────────────────┐          │               │
│  │  Mental Clarity     │   │   Reminder          │          │               │
│  │  (@clear_mind,      │   │   Management        │◄─────────┘               │
│  │   @change_mind)     │   │   (Persistent       │                          │
│  │   - Clears msgs     │   │    across clarity)  │                          │
│  │   - Clears Q4H      │   └─────────────────────┘                          │
│  │   - Preserves reminders                                                      │
│  └─────────────────────────────────────────────────────────────────────────────┘
│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Q4H Index in `q4h.yaml`**: Q4H questions are indexed in `q4h.yaml` (as an index, not source of truth) and cleared by mental clarity operations. The actual question content is in the dialog's conversation messages where the `@human` call was made. They do not survive `@clear_mind` or `@change_mind`.

2. **Hierarchical Q4H**: Any dialog in the hierarchy can raise Q4H on its own right (root dialog or subdialog). Questions are indexed in the dialog that asked them, not passed upward.

3. **Subdialog Q4H Autonomy**: Subdialogs can ask Q4H questions directly, not as a proxy for parent. User navigates to subdialog's conversation to answer inline.

4. **UI Renders Q4H Like Teammate Calls**: The UI treats Q4H similarly to other teammate calls - with navigation linking to the call site in the dialog conversation. The user answers inline using the same input textarea used for regular messages.

5. **Subdialog Response Supply**: Subdialogs write their responses to the _current caller’s_ context via persistence (not callbacks). For TYPE B, each call updates the subdialog’s `assignmentFromSup` with the latest caller + callInfo, so the response is routed to the most recent caller (root or subdialog). This enables detached operation, reuse, and crash recovery.

6. **Subdialog Registry**: Registered subdialogs (TYPE B calls) are tracked in a root-dialog-scoped registry. The registry persists across `clear_mind` operations and is rebuilt on root load.

7. **State Preservation Contract**:
   - `@clear_mind`/`@change_mind`: Clears messages, clears Q4H index, preserves reminders, preserves registry
   - Subdialog completion: Writes response to supdialog, removes from pending list (registry unchanged)
   - Q4H answer: Clears the answered question from index, continues the dialog

---

## Q4H: Questions for Human

### Overview

Q4H (Questions for Human) is the mechanism by which dialogs can suspend execution and request human input. It is a core, integral mechanism that works seamlessly with subdialogs, reminders, and mental clarity tools.

### Q4H Data Structure

```typescript
/**
 * HumanQuestion - index entry persisted in q4h.yaml per dialog
 * NOTE: This is an INDEX, not the source of truth. The actual question
 * content is in the dialog's conversation messages where @human was called.
 */
interface HumanQuestion {
  readonly id: string; // Unique identifier (UUID) - matches message ID
  readonly headLine: string; // Question headline/title
  readonly bodyContent: string; // Detailed question context
  readonly askedAt: string; // ISO timestamp
}
```

**Storage Location**: `<dialog-path>/q4h.yaml` - serves as an index for quick lookup

**Source of Truth**: The actual `@human` call is stored in the dialog's conversation messages (round JSONL files), where the question was asked.

### Q4H Mechanism Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Q4H COMPLETE LIFECYCLE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. DETECTION                    2. RECORDING (INDEX ONLY)                   │
│  ┌──────────────────┐           ┌──────────────────┐                        │
│  │ @human teammate  │──────────►│ Create index entry │                       │
│  │ call detected    │           │ in q4h.yaml        │                      │
│  │ in LLM output    │           │ (not source of     │                     │
│  │                  │           │ truth - messages   │                     │
│  │                  │           │ have the content)  │                     │
│  └──────────────────┘           │ Emit questions_count │                    │
│                                  │ _update event        │                    │
│                                  └──────────────────┘                         │
│                                        │                                      │
│                                        ▼                                      │
│  3. SUSPENSION                   4. UI NOTIFICATION                          │
│  ┌──────────────────┐           ┌──────────────────┐                        │
│  │ Generation loop  │           │ Frontend receives │                       │
│  │ breaks (suspend) │           │ questions_count_  │                      │
│  │ Dialog waits for │           │ update event      │                       │
│  │ human response   │           │ Shows Q4H badge   │                       │
│  └──────────────────┘           └──────────────────┘                        │
│                                        │                                     │
│                                        ▼                                     │
│  5. NAVIGATION TO CALL SITE      6. INLINE ANSWER                            │
│  ┌──────────────────┐           ┌──────────────────┐                        │
│  │ User clicks Q4H  │           │ User types answer │                       │
│  │ in panel/list    │           │ in input textarea │                      │
│  │ Navigates to     │           │ (same as regular  │                      │
│  │ @human call site │           │ messages)         │                      │
│  └──────────────────┘           └─────────┬─────────┘                       │
│                                           │                                  │
│                                           ▼                                  │
│  7. CONTINUATION                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ Backend receives answer, clears q4h.yaml index entry,                 │   │
│  │ drives dialog with answer, dialog resumes                             │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### When Does a Dialog Raise Q4H?

Q4H is raised when the `@human` teammate call is invoked by ANY dialog (root or subdialog) on its own right:

```typescript
// From main/llm/driver.ts, collectAndExecuteTextingCalls function
if (firstMention === 'ask_human' || firstMention === 'human') {
  suspend = true;
}
```

**Invocation Pattern**:

```
@human: <question headline>
<question body content>
```

Or:

```
@human: <question headline>
<question body content>
```

### Q4H Recording Process

```typescript
// When @human is detected as a teammate call
async function recordQuestionForHuman(
  dlg: Dialog,
  headLine: string,
  bodyContent: string,
): Promise<void> {
  const question: HumanQuestion = {
    id: generateDialogID(),
    headLine,
    bodyContent,
    askedAt: formatUnifiedTimestamp(new Date()),
  };

  // Load existing questions
  const existing = await DialogPersistence.loadQuestions4HumanState(dlg.id);

  // Append new question
  await DialogPersistence._saveQuestions4HumanState(dlg.id, [...existing, question]);

  // Emit event for UI notification
  await dlg.updateQuestions4Human([...existing, question]);
}
```

### How UI Knows About Q4H

**Event-Based Notification**:

When a question is recorded, the system emits a `questions_count_update` event:

```typescript
// From main/persistence.ts, DiskFileDialogStore.updateQuestions4Human
const questionsCountUpdateEvt: QuestionsCountUpdateEvent = {
  type: 'questions_count_update',
  previousCount: existing.length,
  questionCount: questions.length,
  dialog: {
    selfId: dialog.id.selfId,
    rootId: dialog.id.rootId,
  },
  round: dialog.currentRound,
};
postDialogEvent(dialog, questionsCountUpdateEvt);
```

**Frontend Response**:

1. Receives `questions_count_update` event
2. Reads `q4h.yaml` to get question index entries
3. Displays Q4H indicator/badge on dialog
4. Questions link to their call sites in the conversation
5. User clicks link to navigate to call site, answers inline

### How User Answers Q4H (Agent-Pull Model)

**Wire Protocol**: `drive_dialog_by_user_answer`

When a dialog is suspended due to Q4H, the agent is waiting for human input. The wire protocol uses an "agent-pull" styled packet to trigger resumption:

```typescript
// shared/types/wire.ts
interface DriveDialogByUserAnswerRequest {
  type: 'drive_dialog_by_user_answer';
  dialog: DialogIdent;
  content: string; // User's answer text
  msgId: string; // Unique ID for tracking
  questionId: string; // ID from q4h.yaml being answered
  continuationType: 'answer';
}
```

**Process (Agent-Pull Model)**:

1. User sees Q4H indicator/badge in UI
2. User clicks Q4H in panel/list, navigates to the `@human` call site
3. User types answer in the input textarea (same as regular messages)
4. Frontend sends `drive_dialog_by_user_answer` packet
5. Backend validates `questionId` against q4h.yaml
6. Backend clears the answered Q4H from q4h.yaml index
7. Backend calls `driveDialogStream()` with human response as prompt
8. Agent resumes generation with new context (agent-pull satisfied)

**Key Design Points**:

- Uses dedicated packet type for Q4H answers, distinct from regular user messages
- `questionId` ensures the correct Q4H is cleared and answered
- Backend atomically: clear q4h.yaml → resume dialog
- Agent-pull: agent waits for this specific packet before continuing

**Comparison with Regular Messages**:

| Aspect            | Regular Message         | Q4H Answer                          |
| ----------------- | ----------------------- | ----------------------------------- |
| Packet Type       | `drive_dlg_by_user_msg` | `drive_dialog_by_user_answer`       |
| questionId        | Not present             | Required                            |
| Backend Action    | Just drive dialog       | Clear q4h.yaml first → drive dialog |
| Continuation Type | N/A                     | `'answer'`                          |

### Subdialog Q4H Handling

**Key Principles**:

1. Q4H is indexed in the dialog that asked it, not passed upward to the supdialog
2. Subdialogs ask Q4H on their own right (not as proxy for parent)
3. User navigates to subdialog's conversation to answer inline
4. The `q4h.yaml` file is an index, not source of truth

```
┌─────────────────────────────────────────────────────────────────┐
│                    Subdialog Q4H Handling                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Supdialog                        Subdialog (autonomous)         │
│  ┌──────────────┐                 ┌──────────────┐               │
│  │              │                 │              │               │
│  │  Running...  │                 │  @human: │               │
│  │              │                 │  "Need info" │               │
│  │  Pending:    │                 │  ----------> │               │
│  │  - sub-001   │                 │              │               │
│  │              │                 │  Index in     │               │
│  │              │                 │  sub-001/     │               │
│  │              │                 │  q4h.yaml     │               │
│  │              │                 │  (index only) │               │
│  │              │                 │  Suspend      │               │
│  └──────┬───────┘                 └──────┬───────┘               │
│         │                              (suspended)               │
│         │                                                      │
│         │ Hierarchical indicator shows subdialog has Q4H        │
│         │ User navigates to subdialog:                         │
│         │                                                      │
│         ├───────────────────────────────────────────────────────►
│         │ User views subdialog's Q4H call site                  │
│         │ User types answer in subdialog's input textarea       │
│         │ (same input area used for regular messages)           │
│         │                                                       │
│         │ 1. Load subdialog hierarchy                           │
│         │ 2. Clear subdialog/q4h.yaml index                     │
│         │ 3. Drive subdialog with answer                        │
│         │                                                       │
│         │ Subdialog resumes:                                    │
│         │                                                       │
│         │ (subdialog completes, supplies response)              │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐                 ┌──────────────┐               │
│  │              │                 │              │               │
│  │  Receives    │◄────────────────│  Completed   │               │
│  │  subdialog   │   Response      │              │               │
│  │  response    │   via storage   │  Supply to    │               │
│  │              │                 │  supdialog    │               │
│  └──────────────┘                 └──────────────┘               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Q4H and Mental Clarity Operations

**Critical Design Decision**: Q4H questions are **CLEARED** by `@clear_mind` and `@change_mind` operations.

```
┌─────────────────────────────────────────────────────────────────┐
│           Q4H Clearing Through Clarity Operations                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BEFORE @clear_mind:                                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Messages: [msg1, msg2, msg3, msg4, @human: "?"]     │    │
│  │ Reminders: [R1, R2]                                      │    │
│  │ Q4H: [{id: "q1", headLine: "Which approach?"}]          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           │                                      │
│                           ▼ @clear_mind                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Messages: [] (cleared)                                  │    │
│  │ Reminders: [R1, R2] (preserved)                         │    │
│  │ Q4H: [] (CLEARED)                                       │    │
│  │              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^         │    │
│  │              Q4H IS CLEARED!                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  RATIONALE:                                                    │
│  - Fresh start means fresh questions                            │
│  - Old questions may no longer be relevant after clarity        │
│  - User can ask new questions if needed                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Dialog Hierarchy & Subdialogs

### Hierarchy Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DIALOG HIERARCHY EXAMPLE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                           Main Dialog (Root)                                 │
│                           ┌─────────────────┐                                │
│                           │ • task: Feature │                                │
│                           │   Development   │                                │
│                           │ • subdialogs:   │                                │
│                           │   [sub-001, sub-002]                             │
│                           │ • registry:     │                                │
│                           │   {agentId!topicId → subdialog}                  │
│                           └────────┬────────┘                                │
│                                    │                                         │
│              ┌─────────────────────┼─────────────────────┐                  │
│              │                     │                     │                  │
│              ▼                     ▼                     ▼                  │
│     ┌────────────────┐   ┌────────────────┐   ┌────────────────┐           │
│     │   Subdialog    │   │   Subdialog    │   │   Subdialog    │           │
│     │   sub-001      │   │   sub-002      │   │   sub-003      │           │
│     │   (Backend)    │   │   (Frontend)   │   │   (Testing)    │           │
│     │ • supdialog    │◄──│ • supdialog    │◄──│ • supdialog    │           │
│     │   reference    │   │   reference    │   │   reference    │           │
│     └───────┬────────┘   └───────┬────────┘   └───────┬────────┘           │
│             │                   │                   │                       │
│             │                   │                   │                       │
│             │     Nested        │                   │                       │
│             │     Subdialog     │                   │                       │
│             │     (optional)    │                   │                       │
│             │                   │                   │                       │
│             ▼                   │                   │                       │
│     ┌────────────────┐          │                   │                       │
│     │   Subdialog    │          │                   │                       │
│     │   sub-001-001  │          │                   │                       │
│     │   (Database)   │          │                   │                       │
│     └────────────────┘          │                   │                       │
│                                  │                   │                       │
│             Q4H from nested      │                   │                       │
│             dialog stored in     │                   │                       │
│             sub-001-001/q4h.yaml │                   │                       │
│                                  │                   │                       │
│                                  │                   │                       │
│                                  ▼                   ▼                       │
│                                                                              │
│  Storage:                                                                    │
│  .dialogs/run/<root-id>/                                                     │
│  ├── dialog.yaml                                                             │
│  ├── latest.yaml                                                             │
│  ├── reminders.json                                                          │
│  ├── q4h.yaml                    (questions for root dialog)                 │
│  ├── round-001.jsonl                                                         │
│  ├── subdialogs/                                                            │
│  │   ├── sub-001/                                                         │
│  │   │   ├── dialog.yaml                                                  │
│  │   │   ├── q4h.yaml              (questions for sub-001)                 │
│  │   │   └── ...                                                           │
│  │   ├── sub-002/                                                         │
│  │   └── sub-003/                                                         │
│  └── registry.yaml              (registered subdialogs, root-scoped)         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Subdialog Response Supply Mechanism

**Core Principle**: Subdialogs supply responses to supdialog's context via persistence, not callbacks.

```
┌─────────────────────────────────────────────────────────────────┐
│              SUBDIALOG RESPONSE SUPPLY FLOW                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SUPDIALOG CREATES SUBDIALOG                                  │
│  ┌──────────────────┐   createSubDialog()   ┌────────────────┐  │
│  │    Supdialog     │ ─────────────────────►│   Subdialog    │  │
│  │                  │                       │                │  │
│  │ • Adds to        │                       │ • Starts fresh │  │
│  │   pending list   │                       │   context      │  │
│  │ • Continues      │                       │ • Has parent   │  │
│  │   execution      │                       │   reference    │  │
│  └──────────────────┘                       └───────┬────────┘  │
│                                                      │           │
│                                                      ▼           │
│  2. SUBDIALOG EXECUTES (detached from parent)                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  Subdialog runs independently, can:                         │  │
│  │  • Execute tools                                            │  │
│  │  • Raise Q4H (stored in subdialog/q4h.yaml)                 │  │
│  │  • Create nested subdialogs                                 │  │
│  │  • Make teammate calls (TYPE A, B, C)                       │  │
│  │  • Complete and supply response                             │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  3. SUBDIALOG COMPLETES                                           │
│  ┌──────────────────┐                       ┌────────────────┐  │
│  │    Subdialog     │  writeResponse()      │   Supdialog    │  │
│  │                  │ ─────────────────────►│                │  │
│  │ • Extract summary│                       │ • Receives     │  │
│  │ • Persist to     │                       │   response     │  │
│  │   storage        │                       │ • Removes from │  │
│  │ • Signal done    │                       │   pending list │  │
│  └──────────────────┘                       │ • Can auto-    │  │
│                                             │   revive       │  │
│                                             └───────┬────────┘  │
│                                                     │            │
│                                                     ▼            │
│  4. SUPDIALOG REVIVAL (optional)                                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  Supdialog checks:                                          │  │
│  │  • Are all pending subdialogs done?                         │  │
│  │  • Incorporate responses into context                      │  │
│  │  • Auto-revive with new context                            │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Subdialog Q4H and Supdialog Revival

When a subdialog has raised Q4H and is waiting for human input, the supdialog's auto-revival logic must handle this:

```typescript
// Supdialog checks subdialog completion status
async function checkSubdialogRevival(supdialog: Dialog): Promise<void> {
  const pending = await loadPendingSubdialogs(supdialog.id);

  for (const p of pending) {
    // Check if subdialog has unresolved Q4H
    const subdialogQ4H = await DialogPersistence.loadQuestions4HumanState(p.subdialogId);

    if (subdialogQ4H.length > 0) {
      // Subdialog is waiting for human input
      // Do NOT auto-revive - wait for human to answer Q4H
      log.debug(`Subdialog ${p.subdialogId} has ${subdialogQ4H.length} Q4H, skipping auto-revive`);
      continue;
    }

    // Subdialog has no Q4H, check if it's done
    const isDone = await isSubdialogCompleted(p.subdialogId);
    if (isDone) {
      // Incorporate response and auto-revive
      await incorporateSubdialogResponse(supdialog, p.subdialogId);
    }
  }
}
```

---

## Mental Clarity Tools

**Implementation**: Both `@clear_mind` and `@change_mind` delegate to `Dialog.startNewRound()`, which:

1. Clears all chat messages
2. Clears all Q4H questions
3. Increments the round counter
4. Updates the dialog's timestamp

### @clear_mind

**Purpose**: Achieve mental clarity by clearing conversational noise while preserving essential context.

**Texting Call Syntax** (unchanged):

```
@clear_mind: <headLine>
<callBody (optional)>

<restContent - becomes first user message in new round>
```

**Behavior**:

- Clears all chat messages in the current dialog
- Preserves all reminders
- **Clears all Q4H questions** (critical!)
- Preserves subdialog registry (root dialog only)
- Has no effect on supdialog
- Redirects attention to task document
- The text AFTER the complete `@clear_mind:` call section becomes the **first `role=user` message** in the new round
- Starts a new conversation round

**Message Flow**:

```
BEFORE (LLM output):
@clear_mind: I want mental clarity
The conversation has too much debug output

Actually, let's focus on Z instead

AFTER @clear_mind:
[new round starts]
[msg1: user, "Actually, let's focus on Z instead"]  <-- restContent
```

**Use Cases**:

- When conversation becomes cluttered with debugging output
- After resolving complex technical issues
- Before starting new phases of work
- When attention feels fragmented

**Implementation Notes**:

- Operation is scoped to the current dialog only
- Subdialogs are not affected by parent's @clear_mind
- Task document remains unchanged and accessible
- Reminders provide continuity bridge across the clarity operation
- **Q4H is cleared** - user can ask new questions if needed
- **Registry is preserved** - registered subdialogs remain registered
- Internally calls `Dialog.startNewRound()` for all clearing and round management

### @change_mind

**Purpose**: Fundamentally shift task direction by updating the workspace task document file that all dialogs reference.

**Texting Call Syntax** (unchanged):

```
@change_mind: <headLine>
<callBody (optional)>

<restContent - becomes first user message in new round>
```

**Behavior**:

- Updates the workspace task document file (e.g., `tasks/feature-auth.md`) with new content
- **Does not change the task document path.** `dlg.taskDocPath` is immutable for the dialog's entire lifecycle.
- The updated file immediately becomes available to all dialogs referencing it
- Clears all chat messages in the current dialog
- Preserves all reminders
- **Clears all Q4H questions** (critical!)
- Preserves subdialog registry (root dialog only)
- Has no effect on supdialog
- Affects all participant agents (main and subdialogs) referencing the same task document
- The text AFTER the complete `@change_mind:` call section becomes the **first `role=user` message** in the new round
- Starts new conversation round for current dialog

**Message Flow**:

```
BEFORE (LLM output):
@change_mind: Requirements changed
The client wants reporting instead of auth

Actually, let's build the reporting module first

AFTER @change_mind:
[new round starts]
[msg1: user, "Actually, let's build the reporting module first"]  <-- restContent
```

**Use Cases**:

- When user requirements change significantly during the DevOps lifecycle
- When pivoting to a different strategic approach for the assignment
- When discovering fundamental misunderstandings about objectives
- When external constraints change the problem space
- When multiple team members need to coordinate on updated requirements

**Implementation Notes**:

- Operation affects all dialog trees referencing the same workspace task document file
- Task document changes are immediately visible to any dialog that loads the file
- Multiple dialog trees working on the same task document receive the updates simultaneously
- Hierarchical relationships and contexts are preserved
- The task document file persists beyond individual conversations and team changes
- `dlg.taskDocPath` is readonly after dialog creation; @change_mind only overwrites the file contents at that path
- **Q4H is cleared** - new direction means new questions
- **Registry is preserved** - registered subdialogs remain registered
- After updating the task document, calls `Dialog.startNewRound()` for all clearing and round management

---

## Reminder Management

**Tools**: @add_reminder, @update_reminder, @delete_reminder

**Purpose**: Manage dialog-scoped working memory that persists across conversation cleanup.

**Behavior**:

- Scoped to individual dialogs
- **Survive @clear_mind operations**
- **Survive @change_mind operations**
- Provide guidance for refreshed mental focus
- Support structured capture of insights, decisions, and next steps

**Relationship with Q4H**:

- Reminders persist across mental clarity operations
- Q4H is cleared by mental clarity operations
- They serve different purposes:
  - **Reminders**: Self-generated notes for continuity (survive clarity)
  - **Q4H**: External requests requiring human input (cleared by clarity)

---

## Subdialog Registry

### Overview

The **subdialog registry** is a root-dialog-scoped data structure that maintains persistent references to registered subdialogs created via TYPE B (Registered Subdialog Call) teammate calls.

### Key Characteristics

| Aspect          | Description                                            |
| --------------- | ------------------------------------------------------ |
| **Scope**       | Root dialog only (not accessible to subdialogs)        |
| **Key Format**  | `agentId!topicId` (single-level Map)                   |
| **Storage**     | `registry.yaml` in root dialog directory               |
| **Lifecycle**   | Never deleted during dialog lifetime                   |
| **Persistence** | Moves with root to `done/` when root completes         |
| **Restoration** | Rebuilt on root load by scanning done/ subdialog YAMLs |

### Registry Operations

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SUBDIALOG REGISTRY OPERATIONS                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  REGISTRY STRUCTURE:                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │  registry.yaml                                                  │        │
│  │  {                                                              │        │
│  │    "researcher!market-analysis": {                              │        │
│  │      "subdialogId": "uuid-123",                                 │        │
│  │      "agentId": "researcher",                                   │        │
│  │      "topicId": "market-analysis",                              │        │
│  │      "createdAt": "2025-12-27T10:00:00Z",                       │        │
│  │      "lastAccessed": "2025-12-27T11:30:00Z"                     │        │
│  │    },                                                           │        │
│  │    "code-reviewer!pr-456": {                                    │        │
│  │      "subdialogId": "uuid-789",                                 │        │
│  │      ...                                                        │        │
│  │    }                                                            │        │
│  │  }                                                              │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  OPERATION: REGISTERED SUBDIALOG CALL (TYPE B)                              │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │  LLM emits: @researcher !topic market-analysis                  │        │
│  │         │                                                        │        │
│  │         ▼                                                        │        │
│  │  ┌───────────────────────────────────────────────────────────┐  │        │
│  │  │  KEY = "researcher!market-analysis"                        │  │        │
│  │  │  CHECK registry.get(KEY)                                   │  │        │
│  │  └───────────────────────────────────────────────────────────┘  │        │
│  │         │                       │                               │        │
│  │    EXISTS                     NOT FOUND                         │        │
│  │         │                       │                               │        │
│  │         ▼                       ▼                               │        │
│  │  ┌────────────────┐    ┌────────────────────┐                  │        │
│  │  │ Resume existing│    │ Create new         │                  │        │
│  │  │ subdialog      │    │ subdialog          │                  │        │
│  │  │                │    │                    │                  │        │
│  │  │ Load from      │    │ Register in        │                  │        │
│  │  │ storage        │    │ registry           │                  │        │
│  │  │                │    │ (set KEY → UUID)   │                  │        │
│  │  │ Drive it       │    │ Drive it           │                  │        │
│  │  └────────────────┘    └────────────────────┘                  │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  OPERATION: ROOT LOAD (RESTORATION)                                          │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │  1. Load root's registry.yaml (if exists)                       │        │
│  │  2. If not exists, scan done/ for subdialog YAMLs               │        │
│  │  3. For each subdialog YAML found:                              │        │
│  │     - Extract agentId and topicId                               │        │
│  │     - Rebuild registry entry                                    │        │
│  │  4. Save restored registry.yaml                                 │        │
│  │                                                                  │        │
│  │  This ensures registered subdialogs persist across restarts.    │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Class Design: RootDialog vs SubDialog

**Critical Design Principle**: The subdialog registry is managed exclusively by `RootDialog` and is **not accessible** to `SubDialog` instances.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CLASS RESPONSIBILITY SEPARATION                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────┐                                           │
│  │        RootDialog           │                                           │
│  │                             │                                           │
│  │  ✓ Manages registry        │                                           │
│  │    - createRegistry()       │                                           │
│  │    - registerSubdialog()    │                                           │
│  │    - lookupSubdialog()      │                                           │
│  │    - saveRegistry()         │                                           │
│  │    - loadRegistry()         │                                           │
│  │                             │                                           │
│  │  ✓ Can make teammate calls  │                                           │
│  │    - TYPE A: @supdialog     │                                           │
│  │    - TYPE B: @agentId       │                                           │
│  │      !topic <id>            │                                           │
│  │    - TYPE C: @agentId       │                                           │
│  │      (transient)            │                                           │
│  │                             │                                           │
│  │  ✗ NO supdialog reference   │                                           │
│  └─────────────┬───────────────┘                                           │
│                │                                                           │
│                │ creates                                                   │
│                │ manages                                                   │
│                ▼                                                           │
│  ┌───────────────────────────────────────────┐                             │
│  │              SubDialog                     │                             │
│  │                                          │                             │
│  │  ✓ Has supdialog reference               │                             │
│  │    - subdialog.supdialog                 │                             │
│  │                                          │                             │
│  │  ✓ Can make teammate calls               │                             │
│  │    - TYPE A: @supdialog (clarification)  │                             │
│  │    - TYPE B: @agentId !topic <id>        │                             │
│  │    - TYPE C: @agentId (transient)        │                             │
│  │                                          │                             │
│  │  ✗ NO registry access                    │                             │
│  │    - Cannot lookup/register              │                             │
│  │    - Cannot traverse sibling subdialogs  │                             │
│  │                                          │                             │
│  │  ✗ Not a root dialog                     │                             │
│  │    - Cannot have registered subdialogs   │                             │
│  └──────────────────────────────────────────┘                             │
│                                                                              │
│  RATIONALE:                                                                  │
│  - Registry is root-scoped for consistent lifecycle management              │
│  - Subdialogs are independent and transient-capable                         │
│  - Prevents subdialogs from interfering with each other's state             │
│  - Simplifies registry persistence and restoration                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Mutex Semantics**:

- `locked: true` → Subdialog is currently being driven (mutex held)
- `locked: false` → Entry exists but subdialog is not locked (can resume)
- Registry does NOT track: 'active' | 'completed' | 'suspended' lifecycle states

**Design Principle**: The registry tracks "locked" (being driven) vs "unlocked" (can resume) state. It does NOT track dialog lifecycle states (active/completed/suspended). Those are Dialog concerns, not Registry concerns. A registered subdialog may be unlocked (not currently being driven) but still exist as a completed or suspended dialog.

### Registry Persistence

**File Location**: `<root-dialog-path>/registry.yaml`

**Format**:

```typescript
interface SubdialogRegistry {
  [key: string]: {
    subdialogId: string; // UUID of the subdialog
    agentId: string; // Agent identifier
    topicId: string; // Topic identifier
    createdAt: string; // ISO timestamp
    lastAccessed?: string; // ISO timestamp (updated on each call)
    locked: boolean; // Mutex state - is someone driving this right now?
  };
}
```

**Persistence Behavior**:

1. **On Registration**: New entry added to registry, file saved
2. **On Resume**: `lastAccessed` updated, file saved
3. **On Clear Mind**: Registry preserved (not cleared)
4. **On Root Completion**: Registry moves with root to `done/`
5. **On Root Load**: Registry rebuilt from done/ subdialog YAMLs

---

## Technical Architecture

### Dialog Class Structure

The complete Dialog class implementation with all methods, properties, and detailed behavior can be found in `dominds/main/dialog.ts`.

**Key Components**:

- **Hierarchy Support**: Parent-child relationships for subdialog management
- **Memory Management**: Persistent reminders and ephemeral chat messages
- **Mental Clarity Operations**: `startNewRound()` method (clears messages, Q4H, and increments round)
- **Subdialog Management**: Creation and coordination of specialized subtasks
- **Q4H Management**: `updateQuestions4Human()` method for question tracking
- **Memory Access**: Integration with task documents and team/agent memories
- **Registry Management** (RootDialog only): Registration and lookup of subdialogs

### Main Dialog Resolution

For subdialogs needing to communicate with the main dialog (root dialog), see the implementation in `dominds/main/dialog.ts` which provides methods for traversing the dialog hierarchy.

### Persistence Layer

The persistence layer handles:

- **Dialog Storage**: `dominds/main/persistence.ts`
- **Q4H Storage**: `q4h.yaml` per dialog (cleared by @clear_mind/@change_mind)
- **Reminder Storage**: `reminders.json` per dialog
- **Event Persistence**: Round-based JSONL files
- **Registry Storage**: `registry.yaml` per root dialog

**Q4H Persistence Methods**:

```typescript
// In persistence.ts
static async _saveQuestions4HumanState(
  dialogId: DialogID,
  questions: HumanQuestion[],
): Promise<void>

static async loadQuestions4HumanState(
  dialogId: DialogID,
): Promise<HumanQuestion[]>

static async clearQuestions4HumanState(
  dialogId: DialogID,
): Promise<void>
```

**Registry Persistence Methods**:

```typescript
// In RootDialog (dialog.ts)
interface RegistryMethods {
  loadRegistry(): Promise<SubdialogRegistry>;
  saveRegistry(registry: SubdialogRegistry): Promise<void>;
  registerSubdialog(key: string, metadata: SubdialogMetadata): void;
  lookupSubdialog(key: string): SubdialogMetadata | undefined;
  getRegistry(): SubdialogRegistry;
}
```

---

## Dialog Management

### Hierarchy Management

**Creation**: Subdialogs are created when agents need to delegate specialized tasks or when complex problems require decomposition.

**Context Inheritance**: New subdialogs automatically receive:

- Reference to the same workspace task document file (e.g., `tasks/feature-auth.md`); `dlg.taskDocPath` is fixed at dialog creation and never reassigned
- Supdialog texting call context (headLine + callBody) explaining their purpose
- Access to shared team memories
- Access to their agent's individual memories

**Storage**: All subdialogs are stored flat under the main dialog's (root dialog's) `subdialogs/` directory, regardless of nesting depth.

**Navigation**: Each subdialog maintains a reference to its parent, enabling upward traversal to the main dialog.

**Registry**: Registered subdialogs (TYPE B calls) are tracked in the root dialog's registry and persist across restarts.

### Lifecycle Management

**Active State**: Dialogs remain active while agents are working on tasks.

**Completion**: Dialogs transition to completed state when:

- Tasks are finished successfully
- Agents explicitly mark them complete
- Supdialogs determine subtasks are no longer needed
- All pending subdialogs are complete AND all Q4H are answered

**Registry on Completion**: When a root dialog completes, its registry moves with it to the `done/` directory and is preserved for potential restoration.

**Cleanup**: Completed dialogs may be archived or cleaned up based on retention policies.

### Communication Patterns

**Upward Communication**: Subdialogs communicate results, questions, and escalations to their supdialogs.

- **Clarification Requests (TYPE A)**: A subdialog may call its supdialog to request clarification while working on its subtask. The supdialog provides guidance, and the subdialog continues with updated context.
- **Subtask Response**: When a subdialog produces a final "saying" content block (no pending Q4H), that message is treated as the response to the **current caller** recorded in `assignmentFromSup` (root or another subdialog). This keeps responses aligned with the most recent call site.
- **Q4H Escalation**: If a subdialog has Q4H, it suspends. The user can answer via the UI, which triggers continuation of the subdialog only.
- **Registered Subdialogs (TYPE B)**: A parent can resume a previously created registered subdialog, enabling ongoing task continuation.
- **Transient Subdialogs (TYPE C)**: A parent can spawn a one-off subdialog for independent tasks that don't require persistence.

**Downward Communication**: Supdialogs provide context, objectives, and guidance to subdialogs.

**Lateral Communication**: Sibling subdialogs coordinate through their shared supdialog.

**Broadcast Communication**: Main dialog (root dialog) can communicate changes (like workspace task document file updates) to all dialogs through the task document reference.

---

## Memory Management

### Dialog-Scoped Memory

**Chat Messages**: Ephemeral conversation content that can be cleared for mental clarity.

**Reminders**: Semi-persistent working memory that survives clarity operations.

**Q4H Questions**: Transient questions for human input that are **cleared by mental clarity operations**.

**Parent Call Context**: Immutable context explaining why a subdialog was created.

**Subdialog Registry**: Root-dialog-scoped persistent mapping of registered subdialogs (survives clarity operations).

### Workspace-Persistent Memory

**Team-Shared Memories**: Persistent across the entire project lifecycle, shared by all agents.

**Agent-Individual Memories**: Personal knowledge that persists per agent across all dialogs.

### Memory Synchronization

**Task Document Propagation**: Changes to the workspace task document file are immediately visible to all dialogs that reference it.

**Memory Updates**: Team and agent memories are updated asynchronously and eventually consistent across all dialogs.

**Q4H Persistence**: Q4H questions are persisted when created and cleared atomically when answered or when @clear_mind/@change_mind is called.

**Registry Persistence**: Registry is persisted after each modification and restored on root dialog load.

---

## System Integration

### File System Integration

**Dialog Storage**: Each dialog corresponds to a directory structure containing:

```
<dialog-root>/
├── dialog.yaml              - Dialog metadata and configuration
├── latest.yaml              - Current round tracking and status
├── reminders.json           - Persistent reminder storage
├── q4h.yaml                 - Q4H questions storage (CLEARED by clarity tools)
├── registry.yaml            - Subdialog registry (ROOT DIALOG ONLY)
├── round-001.jsonl          - Streamed message files
├── round-002.jsonl          - Additional rounds
└── subdialogs/              - Nested subdialog directories
    ├── <subdialog-1>/
    │   ├── dialog.yaml
    │   ├── q4h.yaml         - Subdialog's Q4H questions (cleared by clarity)
    │   └── ...
    └── <subdialog-2>/
        └── ...
```

**Task Document Storage**: Task documents are regular workspace files (typically `.md` files) that exist independently and are referenced by dialogs through file paths.

**Memory Storage**: Team and agent memories are stored in dedicated files within the workspace.

**Registry Storage**: The subdialog registry (`registry.yaml`) is stored in the root dialog directory and moves to `done/` on root completion.

### CLI Integration

**Dialog Creation**: New dialogs are created through CLI commands with appropriate context.

**Tool Invocation**: Mental clarity tools are invoked through CLI commands or agent actions.

**Status Monitoring**: Dialog status, pending subdialogs, Q4H count, and registered subdialogs can be inspected through CLI tools.

### Agent Integration

**Autonomous Operation**: Agents can independently create subdialogs (TYPE B and C), manage reminders, raise Q4H, and trigger clarity operations.

**Context Awareness**: Agents have full access to their dialog context, memories, hierarchy position, pending Q4H from subdialogs, and (for root dialogs) the subdialog registry.

**Teammate Call Capability**: Agents can invoke all three types of teammate calls:

- TYPE A: Call supdialog for clarification
- TYPE B: Call/Resume registered subdialogs
- TYPE C: Spawn transient subdialogs

**Tool Access**: All mental clarity tools, Q4H capability, and teammate call tools are available to agents for autonomous cognitive management.

---

## State Diagrams

### Dialog State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DIALOG STATE MACHINE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────────┐                                 │
│                              │  CREATED    │                                 │
│                              └──────┬──────┘                                 │
│                                     │                                        │
│                                     ▼                                        │
│                              ┌─────────────┐                                 │
│                    ┌────────►│  ACTIVE     │◄────────┐                      │
│                    │         │  (running)  │         │                      │
│                    │         └──────┬──────┘         │                      │
│                    │                │                │                      │
│    ┌───────────────┼────────────────┼────────────────┼───────────────┐      │
│    │               │                │                │               │      │
│    │               ▼                ▼                │               ▼      │
│    │   ┌──────────────────┐  ┌──────────────────┐    │   ┌────────────────┐ │
│    │   │  AWAITING_Q4H    │  │  AWAITING_SUBDLG │    │   │   COMPLETED    │ │
│    │   │  (Human input    │  │  (Subdialog      │    │   │               │ │
│    │   │   required)      │  │   pending)       │    │   └──────────────┘ │
│    │   └────────┬─────────┘  └────────┬─────────┘    │                     │
│    │            │                     │              │                     │
│    │            ▼                     │              │                     │
│    │   ┌──────────────────┐          │              │                     │
│    │   │ Q4H Answered     │          │              │                     │
│    │   │ (User submits    │          │              │                     │
│    │   │  response)       │          │              │                     │
│    │   └────────┬─────────┘          │              │                     │
│    │            │                     ▼              │                     │
│    │            │         ┌──────────────────┐       │                     │
│    │            │         │ Subdialog Done   │       │                     │
│    │            │         │ (Response        │       │                     │
│    │            │         │  supplied)       │       │                     │
│    │            │         └────────┬─────────┘       │                     │
│    │            │                  │                 │                     │
│    └────────────┼──────────────────┼─────────────────┘                     │
│                 │                  │                                          │
│                 ▼                  ▼                                          │
│                 └─────────► ACTIVE (continue) ◄─────────────┐               │
│                                    │                      │               │
│                                    │                      │               │
│                     ┌──────────────┼──────────────┐       │               │
│                     │              │              │       │               │
│                     ▼              ▼              │       │               │
│            ┌─────────────────┐ ┌─────────────────┐ │       │               │
│            │ @clear_mind     │ │ @change_mind    │ │       │               │
│            │ (clear msgs,    │ │ (update doc,    │ │       │               │
│            │  clear Q4H,     │ │  clear Q4H,     │ │       │               │
│            │  keep reminders │ │  keep reminders)│ │       │               │
│            │  keep registry) │ │  keep registry) │ │       │               │
│            └────────┬────────┘ └────────┬────────┘ │       │               │
│                     │                   │          │       │               │
│                     │    ┌──────────────┴──────────┘       │               │
│                     │    │                             │       │               │
│                     ▼    ▼                             │       │               │
│                     ACTIVE (new round)                 │       │               │
│                                                     (user/agent marks done)│
│                                                     ┌──────────────────────┘
│                                                     ▼
│                                              ┌─────────────┐
│                                              │  COMPLETED  │
│                                              └─────────────┘
│                                                                              │
│  STATE DESCRIPTIONS:                                                         │
│  - CREATED: Initial state, dialog just created                               │
│  - ACTIVE: Normal execution, LLM generating                                  │
│  - AWAITING_Q4H: Suspended, waiting for human Q4H answer                     │
│  - AWAITING_SUBDLG: Suspended, waiting for subdialog completion             │
│  - COMPLETED: Task finished, no further generation                           │
│                                                                              │
│  TRANSITIONS:                                                                │
│  - startNewRound() / createSubdialog(): CREATED -> ACTIVE                   │
│  - @human teammate call: ACTIVE -> AWAITING_Q4H                             │
│  - Q4H answered: AWAITING_Q4H -> ACTIVE                                     │
│  - createSubdialog() / teammate call: ACTIVE -> AWAITING_SUBDLG (parent)    │
│  - subdialog completes: AWAITING_SUBDLG -> ACTIVE                           │
│  - @clear_mind/@change_mind: ACTIVE -> ACTIVE (new round, Q4H cleared)      │
│  - markComplete(): any -> COMPLETED                                         │
│                                                                              │
│  NOTE: Registry is preserved through @clear_mind/@change_mind                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Teammate Call State Transitions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TEAMMATE CALL STATE TRANSITIONS                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TYPE A: SUPDIALOG CALL (@<supdialogAgentId>)                               │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │   Subdialog ACTIVE                                              │        │
│  │         │                                                       │        │
│  │         │ emits @supdialog                                     │        │
│  │         ▼                                                       │        │
│  │   AWAITING_SUBDLG (subdialog suspended)                        │        │
│  │         │                                                       │        │
│  │         │ Driver drives supdialog                              │        │
│  │         ▼                                                       │        │
│  │   Supdialog ACTIVE                                              │        │
│  │         │                                                       │        │
│  │         │ Supdialog responds                                    │        │
│  │         ▼                                                       │        │
│  │   Subdialog ACTIVE (resumed with response)                     │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  TYPE B: REGISTERED SUBDIALOG CALL (@<agentId> !topic <id>)                 │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │   Parent ACTIVE                                                 │        │
│  │         │                                                       │        │
│  │         │ emits @agentId !topic X                              │        │
│  │         ▼                                                       │        │
│  │   Registry lookup:                                             │        │
│  │   ┌─────────────────────────┐                                  │        │
│  │   │ EXISTS                  │ NOT FOUND                        │        │
│  │   └─────────────────────────┘                                  │        │
│  │         │                       │                              │        │
│  │         ▼                       ▼                              │        │
│  │   Load subdialog          Create subdialog                    │        │
│  │   Resume it               Register it                         │        │
│  │         │                       │                              │        │
│  │         ▼                       ▼                              │        │
│  │   ┌─────────────────────────────────────────┐                 │        │
│  │   │  AWAITING_SUBDLG (parent suspended)     │                 │        │
│  │   └─────────────────────────────────────────┘                 │        │
│  │         │                       │                              │        │
│  │         │ Drive subdialog       │ Drive subdialog              │        │
│  │         ▼                       ▼                              │        │
│  │   Subdialog ACTIVE          Subdialog ACTIVE                  │        │
│  │         │                       │                              │        │
│  │         │ Subdialog responds    │ Subdialog responds           │        │
│  │         ▼                       ▼                              │        │
│  │   Parent ACTIVE (resumed with response)                       │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
│  TYPE C: TRANSIENT SUBDIALOG CALL (@<nonSupdialogAgentId>)                  │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                                                                  │        │
│  │   Parent ACTIVE                                                 │        │
│  │         │                                                       │        │
│  │         │ emits @agentId                                        │        │
│  │         ▼                                                       │        │
│  │   Create NEW subdialog (NOT registered)                        │        │
│  │         │                                                       │        │
│  │         ▼                                                       │        │
│  │   AWAITING_SUBDLG (parent suspended)                           │        │
│  │         │                                                       │        │
│  │         │ Drive subdialog                                       │        │
│  │         ▼                                                       │        │
│  │   Subdialog ACTIVE (full capabilities)                         │        │
│  │         │                                                       │        │
│  │         │ Subdialog responds                                    │        │
│  │         ▼                                                       │        │
│  │   Parent ACTIVE (resumed with response)                        │        │
│  │                                                                  │        │
│  │   NOTE: Subdialog is NOT added to registry                     │        │
│  │         Subsequent calls create new subdialogs                 │        │
│  │                                                                  │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Q4H Lifecycle State

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Q4H LIFECYCLE STATES                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│         ┌─────────────┐                                                     │
│         │  CREATED    │                                                     │
│         │ (in q4h.yaml)│                                                    │
│         └──────┬──────┘                                                     │
│                │                                                             │
│                ▼                                                             │
│         ┌─────────────┐     ┌───────────────────┐                           │
│         │  DISPLAYED  │────►│    ANSWERED       │                           │
│         │  (UI shows  │     │    (User selects  │                           │
│         │   badge)    │     │    and submits)   │                           │
│         └──────┬──────┘     └─────────┬─────────┘                           │
│                │                       │                                     │
│                │                       ▼                                     │
│                │              ┌───────────────────┐                         │
│                │              │    CLEARED        │                         │
│                │              │  (removed from    │                         │
│                │              │   q4h.yaml)       │                         │
│                │              └─────────┬─────────┘                         │
│                │                        │                                   │
│                │                        ▼                                   │
│                │              ┌───────────────────┐                         │
│                └─────────────►│    ARCHIVED       │                         │
│                               │    (implicit,     │                         │
│                               │     Q4H removed)  │                         │
│                               └───────────────────┘                         │
│                                                                              │
│  Q4H IS ALSO CLEARED BY:                                                     │
│  - @clear_mind operation                                                    │
│  - @change_mind operation                                                   │
│                                                                              │
│  EVENTS:                                                                     │
│  - @human teammate call: raises Q4H                                  │
│  - questions_count_update event: UI displays badge                          │
│  - User selects Q4H: UI highlights question                                  │
│  - User submits answer: Q4H marked answered                                 │
│  - handleDriveDialogByUserAnswer: Q4H cleared from storage (handles `drive_dialog_by_user_answer` packet)                │
│  - @clear_mind/@change_mind: Q4H cleared                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Subdialog + Q4H Interaction

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              SUBDIALOG Q4H WITH SUPDIALOG REVIVAL LOGIC                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SUPDIALOG                           SUBDIALOG                               │
│  ┌─────────────────┐                ┌─────────────────┐                     │
│  │ ACTIVE          │                │ ACTIVE          │                     │
│  │                 │──create────────►│                 │                     │
│  │ Pending: [sub-1]│   Subdialog     │                 │                     │
│  │ Registry: {}    │                 │                 │                     │
│  └────────┬────────┘                └────────┬────────┘                     │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           │                         │ @human:     │                     │
│           │                         │ "Need info"     │                     │
│           │                         └────────┬────────┘                     │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           │                         │ AWAITING_Q4H    │                     │
│           │◄────────────────────────│ (suspended)     │                     │
│           │   Check status          │ Registry: {}    │                     │
│           │                                  │                               │
│           │  Supdialog can:                  │                               │
│           │  - Continue independently        │                               │
│           │  - Wait for subdialog            │                               │
│           │  - Check pending periodically    │                               │
│           │  - Make other teammate calls     │                               │
│           │                                  │                               │
│           │                                  │ User answers Q4H:             │
│           │                                  │                               │
│           │   handleDriveDialogByUserAnswer(subdialogId: sub-1)           │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           │                         │ ACTIVE          │                     │
│           │                         │ (resumed)       │                     │
│           │                         └────────┬────────┘                     │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           │                         │ COMPLETED       │                     │
│           │◄────────────────────────│ (writes         │                     │
│           │   Supply response       │  response)      │                     │
│           │                         │ Registry: {}    │                     │
│           │                         └─────────────────┘                     │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           │                         │ Response        │                     │
│           │                         │ persisted to    │                     │
│           │                         │ supdialog       │                     │
│           │                         └────────┬────────┘                     │
│           │                                  │                               │
│           │                                  ▼                               │
│           │                         ┌─────────────────┐                     │
│           └─────────────────────────►│ Supdialog can  │                     │
│                      Check           │ continue or     │                     │
│                      complete        │ auto-revive     │                     │
│                                       └─────────────────┘                     │
│                                                                              │
│  NOTE: Registry is NOT modified when subdialog completes                     │
│        (TYPE B calls register, but completion doesn't unregister)            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Flow Reference

### 1. Main Dialog Raises Q4H

```
User or Agent          Main Dialog             Persistence           Frontend
    │                      │                        │                    │
    │ @human: Question│                        │                    │
    ├─────────────────────►│                        │                    │
    │                      │ recordQuestionForHuman()                   │
    │                      │────────────────────────►q4h.yaml           │
    │                      │                        │                    │
    │                      │ questions_count_update                     │
    │                      │───────────────────────────────────────────►│
    │                      │                        │               Show Q4H badge
    │                      │ suspend (break loop)   │                    │
    │                      │◄───────────────────────┘                    │
    │                      │ (waiting)               │                    │
    │                      │                        │                    │
    User selects Q4H:      │                        │                    │
    ├─────────────────────────────────────────────────────────────────────►│
    │                      │                        │                    │
    │  User submits answer │                        │                    │
    ├─────────────────────►│                        │                    │
    │                      │ handleDriveDialogByUserAnswer()           │
    │                      │                        │                    │
    │                      │ loadQuestions4HumanState()                  │
    │                      │────────────────────────►q4h.yaml (read)     │
    │                      │                        │                    │
    │                      │ clearQuestions4HumanState()                 │
    │                      │────────────────────────►q4h.yaml (clear)    │
    │                      │                        │                    │
    │                      │ driveDialogStream(answer)                   │
    │                      │ (resumes with new context)                  │
    │                      │                        │                    │
```

### 2. Subdialog Raises Q4H, User Answers via Root

```
Supdialog           Subdialog            Persistence           Frontend
    │                  │                      │                    │
    │ createSubDialog()│                      │                    │
    ├─────────────────►│                      │                    │
    │                  │ ACTIVE                │                    │
    │                  ├───────────────────────►                    │
    │                  │ @human: Question│                      │
    │                  │ recordQuestionForHuman()                   │
    │                  │────────────────────────►sub/q4h.yaml       │
    │                  │                      │                    │
    │                  │ questions_count_update                    │
    │                  │─────────────────────────────────────────────────►
    │                  │                      │                Show on subdialog
    │                  │ suspend (break)      │                    │
    │                  │◄─────────────────────┘                    │
    │                  │ (waiting)               │                    │
    │                  │                        │                    │
    │  Check pending:  │                        │                    │
    │  ├─ sub-001: Q4H │                        │                    │
    │  │  → Skip       │                        │                    │
    │  ├─ sub-002: done│                        │                    │
    │  │  → Resume     │                        │                    │
    │  │  → Registry   │                        │                    │
    │  └─ sub-003: running                     │                    │
    │                  │                        │                    │
    User selects subdialog Q4H:                                        │
    ├─────────────────────────────────────────────────────────────────────►
    │                  │                        │                    │
    │                  │                        │                    │
    │ handleDriveDialogByUserAnswer(root, answer, {targetSubdialogId})
    │                  │                        │                    │
    │                  │ loadQuestions4HumanState()                  │
    │                  │◄──────────────────────sub/q4h.yaml          │
    │                  │                        │                    │
    │                  │ clearQuestions4HumanState()                 │
    │                  │────────────────────────►sub/q4h.yaml (clear)
    │                  │                        │                    │
    │                  │ driveDialogStream(answer)                   │
    │                  │ (resumes with new context)                  │
    │                  │                        │                    │
    │                  │ COMPLETED              │                    │
    │                  │────────────────────────►sub/response.yaml   │
    │                  │                        │                    │
    │  Supdialog can   │                        │                    │
    │  now check       │                        │                    │
    │  sub-001 status  │                        │                    │
    │                  │                        │                    │
```

### 3. Registered Subdialog Call (TYPE B)

```
Root Dialog         Registry              Subdialog            Persistence
    │                  │                      │                    │
    │ emit @researcher │                      │                    │
    │     !topic market│                      │                    │
    ├─────────────────►│                      │                    │
    │                  │ lookup("researcher!market")               │
    │                  │────────────────────────►                   │
    │                  │                      │                    │
    │  ┌───────────────┴───────────────┐      │                    │
    │  │ NOT FOUND                     │      │                    │
    │  └───────────────────────────────┘      │                    │
    │         │                               │                    │
    │         ▼                               │                    │
    │   createSubdialog()                     │                    │
    │   ├─ subdialogId: uuid-123              │                    │
    │   ├─ agentId: researcher                │                    │
    │   ├─ topicId: market                    │                    │
    │   │                                     │                    │
    │   registerSubdialog(                    │                    │
    │     "researcher!market",                │                    │
    │     { subdialogId: uuid-123, ... }      │                    │
    │   )                                     │                    │
    │                  │                      │                    │
    │                  │ save registry.yaml    │                    │
    │                  │────────────────────────►registry.yaml      │
    │         │                               │                    │
    │         ▼                               ▼                    │
    │   AWAITING_SUBDLG                 ACTIVE                     │
    │   (root suspended)                                              │
    │         │                               │                    │
    │         │ Drive subdialog               │                    │
    │         ├───────────────────────────────►                    │
    │         │                               │                    │
    │         │ ... time passes ...           │                    │
    │         │                               │                    │
    │         │ Subdialog responds            │                    │
    │         │◄──────────────────────────────┤                    │
    │         │                               │                    │
    │         ▼                               │                    │
    │   ACTIVE (root resumed)                 │                    │
    │   with response in context              │                    │
    │         │                               │                    │
    │         │ emit @researcher              │                    │
    │         │     !topic market             │                    │
    │         ├───────────────────────────────►                    │
    │         │                               │                    │
    │         │ lookup("researcher!market")   │                    │
    │         │───────────────────────────────►registry.yaml       │
    │         │                               │                    │
    │  ┌───────────────┬───────────────┐      │                    │
    │  │ EXISTS        │               │      │                    │
    │  │ subdialog:    │               │      │                    │
    │  │ uuid-123      │               │      │                    │
    │  └───────────────┴───────────────┘      │                    │
    │         │                               │                    │
    │         ▼                               │                    │
    │   Load subdialog uuid-123               │                    │
    │   from storage                          │                    │
    │         │                               │                    │
    │         │ update lastAccessed           │                    │
    │         │───────────────────────────────►registry.yaml       │
    │         │                               │                    │
    │         ▼                               ▼                    │
    │   AWAITING_SUBDLG                 RESUMED ACTIVE              │
    │   (root suspended)                 (continues)                │
    │         │                               │                    │
    │         │ ... subdialog continues ...   │                    │
    │         │                               │                    │
```

### 4. Clarity Operations Preserve Registry

```
Dialog State         @clear_mind/@change_mind         Result
─────────────────────────────────────────────────────────────────
Messages: [m1,m2,m3]         │                    Messages: []
Q4H: [{id:1}, {id:2}]        │                    Q4H: [] (CLEARED!)
Reminders: [r1]              │                    Reminders: [r1] (preserved)
Registry: {key1→sub1}        │                    Registry: {key1→sub1} (PRESERVED!)
                              │                    ^ Registry survives!
                              ▼
─────────────────────────────────────────────────────────────────
```

---

## Performance Considerations

### Scalability

**Flat Storage**: Subdialog flat storage prevents deep directory nesting issues.

**Registry Efficiency**: Single-level Map lookup for registered subdialogs is O(1).

**Memory Efficiency**: Shared memories reduce duplication across dialogs.

**Lazy Loading**: Dialog content is loaded on-demand to minimize memory usage.

### Reliability

**Atomic Operations**: Q4H and registry persistence use atomic write patterns (temp file + rename).

**Backup and Recovery**: Dialog state can be backed up and restored independently. Registry is restored from done/ on load.

**Error Handling**: System gracefully handles dialog corruption, missing files, and registry corruption.

### Monitoring

**Performance Metrics**: System tracks dialog creation, completion, registry size, resource usage, and Q4H count.

**Health Checks**: Regular validation of dialog hierarchy integrity, Q4H persistence, registry consistency, and memory.

**Debugging Support**: Comprehensive logging and inspection tools for troubleshooting teammate calls, registry operations, and Q4H flows.

---

## Summary

The Dominds dialog system provides a robust framework for hierarchical, human-in-the-loop AI collaboration:

### Four Core Mechanisms

| Mechanism              | Purpose                       | Survives Clarity | Cleared By                |
| ---------------------- | ----------------------------- | ---------------- | ------------------------- |
| **Dialog Hierarchy**   | Parent-child task delegation  | N/A              | N/A                       |
| **Q4H**                | Human input requests          | No               | @clear_mind, @change_mind |
| **Mental Clarity**     | Context reset tools           | N/A              | N/A                       |
| **Reminders**          | Persistent working memory     | Yes              | N/A                       |
| **Subdialog Registry** | Registered subdialog tracking | Yes              | Never deleted             |

### Three Types of Teammate Calls

| Type       | Syntax                   | Registry                | Use Case                  |
| ---------- | ------------------------ | ----------------------- | ------------------------- |
| **TYPE A** | `@<supdialogAgentId>`    | No                      | Clarification from parent |
| **TYPE B** | `@<agentId> !topic <id>` | Yes (lookup + register) | Resume persistent subtask |
| **TYPE C** | `@<nonSupdialogAgentId>` | No                      | One-off independent task  |

### Class Responsibility

- **RootDialog**: Manages registry, can make all three teammate call types
- **SubDialog**: Has supdialog reference, can make TYPE A and TYPE C directly; TYPE B routes through the root registry and updates caller context on each call

### Persistence Guarantees

- **Q4H**: Persisted, cleared by clarity operations
- **Reminders**: Persisted, survives clarity operations
- **Registry**: Persisted, survives clarity operations, moves to done/ on completion
- **Subdialogs**: Registered subdialogs persist in registry; transient subdialogs are not registered

---

_Document version: 3.0_
_Last updated: 2025-12-27_
