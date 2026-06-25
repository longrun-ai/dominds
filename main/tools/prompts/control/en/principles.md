# control Principles and Core Concepts

## Template (Principles)

### Design Goals

- <Goal 1>
- <Goal 2>

### Contract Principles

- <Input/Output contract rules>

### Safety & Boundaries

- <Access constraints / guardrails>

### Failure & Recovery

- <What to do when a call fails>

### Glossary

- <Toolset-specific terms>

## Core Concepts

### 1. Reminder

Reminders are temporary current-work notes with three scopes:

- `dialog`: current-dialog only
- `task`: visible across dialogs for the current Taskdoc
- `agent`: visible in later dialogs you lead, but only for urgent, short-lived, globally visible cues

Default to `task`. Use `dialog` only when the note is truly dialog-local; use `agent` only when the note is urgent, short-lived, and globally visible.

**Characteristics:**

- `dialog` reminders stay in the current dialog only
- `task` reminders stay visible under the current Taskdoc
- `agent` reminders stay visible in later dialogs you lead
- Can be added, modified, or deleted at any time
- Should stay compact, scannable, and directly actionable by default
- Main Dialogs have a fixed goal reminder. Read the whole reminder: if it says to ask the human, ask first and record the answer with `set_dialog_goal`; if it says "proceed from the Taskdoc" and has no parallel-dialog note, continue from the Taskdoc; if the same reminder says Dominds has confirmed a parallel dialog, ask the human first. Ordinary `dialog` continuation-package reminders keep details easy to lose during resume. Side Dialogs maintain sufficiently detailed `dialog` continuation-package reminders and state that Side Dialog's task goal. If Dominds has already warned that context is tight or critical, Side Dialog reminders have no fixed length limit and rough multi-reminder carry-over is acceptable

**Difference from memory:**
| Feature | dialog reminder | task reminder | agent reminder | personal memory |
|---------|-----------------|---------------|----------------|-----------------|
| Persistence | Current dialog only | Current Taskdoc | Across later dialogs you lead | Long-term / file-backed |
| Visibility | Current dialog | Current-task dialogs | Current Dialog Responder | Current agent |
| Best for | Current next step, blocker, volatile clue | Current work under one task | Urgent, short-lived, global cue | Stable facts / reusable knowledge |

### 1.1 Scope Choice Rule

- Default to `task`:
  - a preferred smoke-check command for this task
  - a recurring safety check for this task
  - an operating watchpoint that should survive dialog boundaries for this Taskdoc
- Use `dialog` for truly dialog-local notes:
  - current blockers
  - temporary paths, ids, commands, sample inputs
  - bridge notes that matter only for this dialog / current course
- Use `agent` only for urgent, short-lived, globally visible cues that should appear across dialogs you lead.
- If the content is a durable fact or knowledge asset rather than an active current-work cue, it likely belongs in `personal_memory`, not in any reminder scope.

### 2. Taskdoc

Taskdoc is a **task contract** and the task's **team-shared source of current truth** during execution; within it, `progress` acts as a **quasi-real-time team task bulletin board / current effective-state snapshot**.

**Structure:**

- **goals.md**: Task objectives
- **constraints.md**: Constraints
- **progress.md**: The current effective state, key decisions, next steps, and still-active blockers for team-wide sync

**Update Rules:**

- `do_mind` creates a new section; `mind_more` appends small entries; `change_mind` replaces an existing full section; `never_mind` deletes a whole section file
- Does not start a new course
- Changes visible to all teammates
- When writing `progress`, assume teammates will skim it to synchronize on the current task truth rather than read your private process log
- Do not keep blindly calling `mind_more` until `progress` becomes a chronology; when the bulletin board starts accumulating duplicates, stale entries, or noisy history, use `change_mind` to condense it around facts that are still effective now
- Detailed investigations, long logs, full plans, acceptance records, and expanded rationale belong in formal rtws documentation; Taskdoc should keep only the key point, current conclusion, next step, and a location pointer such as path/section/command

## Tool Overview

| Tool             | Function                                         |
| ---------------- | ------------------------------------------------ |
| add_reminder     | Add reminder                                     |
| delete_reminder  | Delete reminder                                  |
| update_reminder  | Update reminder content                          |
| migrate_reminder | Move an over-shared reminder back to this dialog |
| set_dialog_goal  | Set this Main Dialog's goal                      |
| do_mind          | Create new Taskdoc section                       |
| mind_more        | Append entries to Taskdoc (defaults to progress) |
| change_mind      | Replace existing Taskdoc section                 |
| never_mind       | Delete Taskdoc section file                      |
| recall_taskdoc   | Read taskdoc chapter                             |

## Inter-dialog Reply Routing

### Decision Rules

- If the current Side Dialog is unfinished, first judge whether team SOP / role ownership already identifies the responsible owner; if yes and the issue is execution work, directly use `tellask` / `tellaskSessionless` for that owner
- Do not treat an agent teammate like a human coworker who can only handle one conversation at a time. Same teammate + same `sessionSlug` = continue the same task and update that task; `tellaskSessionless` or a different `sessionSlug` = another independent task
- Call `tellaskBack({ tellaskContent })` only when the tellasker must clarify the request, decide a tradeoff, confirm acceptance criteria, provide missing input, or current SOP cannot determine ownership
- If a human must personally perform login / GUI / captcha / high-risk authorization: call `askHuman({ tellaskContent })`
- If the current Side Dialog is complete and the task header says `replyTellask`: call `replyTellask({ replyContent })`
- If the current Side Dialog is complete and the task header says `replyTellaskSessionless`: call `replyTellaskSessionless({ replyContent })`
- If you are answering a tellasker `tellaskBack` follow-up and Dominds shows `replyTellaskBack`: call `replyTellaskBack({ replyContent })`
- Plain text is not the completion channel for inter-dialog delivery. If you write final content for the requester but do not send it through the reply tool named by Dominds, Dominds may temporarily remind you to use that tool. Do not treat plain text as the formal reply path; the other dialog may not receive a formal reply that way.

### Low-Burden Rule

- Focus on doing the current task correctly first; send the final reply only when the final content is ready and Dominds names a reply tool
- Do not memorize reply variants by yourself; follow the current task header and the reply tool currently named/shown by Dominds
- Reply tool descriptions are intentionally minimal and spec-like; use this manual's principles / scenarios for situational guidance
- If Dominds names/shows only one reply tool, that is the only correct completion path for the current state
- `tellaskBack` is valid only when ownership cannot be determined from existing SOP, or when the tellasker must answer; it is not the default first move for every blocked state

## Best Practices

### 1. Reminder Usage Scenarios

- **Current work**: next step, blockers, key pointers
- **Easy-to-lose details**: temporary paths, ids, commands, sample inputs
- **Course transition**: Main Dialog goals come from the fixed goal reminder; ordinary `dialog` continuation packages keep next steps, key pointers, run/verify notes, and volatile details. Side Dialog continuation packages must state that Side Dialog's task goal, including rough multi-reminder carry-over when already degraded
- **Task carry-over**: if you should keep seeing the note under the current Taskdoc, use `task`
- **Global urgent cue**: if you should keep seeing it across later dialogs you lead, and it is urgent, short-lived, and globally visible, use `agent`

### 2. Taskdoc Update Timing

- **Goal changes**: When task objectives change
- **Constraint adjustments**: When constraints need adjustment
- **Progress updates**: When the team needs the current effective state, key decisions, next steps, or still-active blockers synchronized

### 3. Update Strategy

- Keep concise: reminders are often 1-3 items; prefer `update_reminder` to compress/merge
- Separate carriers: information that must synchronize the team's current effective state, key decisions, next steps, or still-active blockers belongs in `progress`, the quasi-real-time task bulletin board; reminders keep local resume details
- Do not duplicate system state: background process status, in-flight background asks/collaboration, browser/session attachment state, and similar environment state automatically maintained by Dominds do not belong in manual reminders. Dominds-managed reminders, panels, and tool outputs are the authoritative place for that state; manual copies go stale easily and create cognitive noise
- Team-facing: keep `progress` scannable and centered on what is still effective now; do not let it degrade into a personal log, raw chronology, scratchpad, or stale history pile. Use `mind_more` for small additions; when cleanup/reordering/compression is needed, call `recall_taskdoc` first and then use `change_mind` with the returned `content_hash` as `previous_content_hash`
- Condense when needed: `mind_more` is not the default bookkeeping move. If one topic already has several phase notes, prefer `change_mind` to merge them into the current summary; put the detailed expansion in formal rtws documentation and keep a document pointer in Taskdoc. If the replacement would overwrite existing content, proceed only with direct human confirmation or after applying a human-approved SOP/acceptance standard that considers the existing content
- Collapse before clearing: in a Main Dialog, first read the fixed goal reminder. If it says to ask the human, ask and record the answer with `set_dialog_goal`. Then write only facts that other dialogs/teammates sharing the same Taskdoc truly need into the appropriate Taskdoc sections, and keep resume-critical details for this dialog in `dialog` reminders. A Side Dialog must not maintain Taskdoc or draft Taskdoc update proposals, and should directly maintain sufficiently detailed `dialog` continuation-package reminders that state that Side Dialog's task goal. If Dominds has already warned that context is tight or critical, rough multi-reminder carry-over is acceptable; once the new course starts, continue this dialog from the fixed Main Dialog goal reminder or the Side Dialog task goal in `scope=dialog` reminders before reconciling
- Avoid raw-material dumps: do not paste long logs or large tool outputs into reminders
- Documentation layering: Taskdoc says “what the team should sync on / do next now”; formal rtws documentation carries “why, how, detailed evidence, and the full process”. When Taskdoc references formal rtws documentation, use a stable path/section name/relevant command instead of copying the full content

### 4. What Belongs in `progress`

- Good fits for `progress`:
  - key decisions already in effect
  - blockers that are confirmed and still active
  - the next step the team should currently align on
  - completed stage closures and remaining gaps
  - a short summary of content already written to formal rtws documentation, plus a pointer to that document
- Poor fits for `progress`:
  - “I just read file X”
  - “I might try a small idea next”
  - scratch notes only useful to the current speaker
  - historical traces whose current validity is unclear
  - detailed expansions, long logs, full plans, or acceptance-record text that belongs in formal rtws documentation

## Limitations and Notes

1. `dialog` reminders end with the dialog; `task` reminders stay visible under the current Taskdoc; `agent` reminders stay visible in later dialogs you lead
2. Use `do_mind` to create missing Taskdoc sections; use `mind_more` for small Taskdoc additions; use `change_mind` for full-section replacement of existing sections only after merging existing content and calling `recall_taskdoc` for the current `content_hash`; use `never_mind` when a whole section file should be deleted. Do not treat `mind_more` as a chronology tool; when cleanup, stale-entry removal, or same-topic consolidation is needed, use `recall_taskdoc` then `change_mind`
3. `do_mind` / `mind_more` / `change_mind` / `never_mind` do not start a new course
4. Main Dialog goals live in the fixed goal reminder and must be changed with `set_dialog_goal`; ordinary `dialog` reminders keep continuation details only. Side Dialog continuation-package reminders must be current-dialog scoped (`scope=dialog`) and state that Side Dialog's task goal. In the Main Dialog, write only facts that other dialogs/teammates sharing the same Taskdoc truly need into Taskdoc, while reminders keep details still not covered by Taskdoc but easy to lose when resuming this dialog
5. Do not turn `task` / `agent` reminders into a long-term fact dump; move durable knowledge into `personal_memory`
