# control Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Reminder Current-Work Tracking

### Scenario Description

Use reminders for the current task's current work: next steps, blockers, and volatile details that are not meant to become the team's Taskdoc bulletin board. Main Dialog goals come from the fixed goal reminder and are maintained with `set_dialog_goal`; ordinary continuation packages before `clear_mind` keep resume details only. Side Dialog continuation packages must explicitly use `scope=dialog` and state that Side Dialog's task goal.

### Example

```typescript
// Default to task scope: visible when continuing the same Taskdoc in a new dialog
add_reminder({
  content: 'Next step: verify the control manual wording against Taskdoc progress semantics',
});

// Use dialog only when the note is truly local to the current dialog
add_reminder({
  content: 'In this dialog, compare against line 12 of the last tool output',
  scope: 'dialog',
});

// Main Dialog goals are maintained through the fixed goal reminder; ordinary dialog reminders keep resume details
set_dialog_goal({
  mode: 'goal',
  goal: 'Keep reviewing control-manual course-transition guidance.',
});

add_reminder({
  content:
    'Next check whether scenarios/index still imply task scope for continuation packages; focus on the control manual reminder-scope wording.',
  scope: 'dialog',
});

// Use agent only for urgent, short-lived, globally visible cues
add_reminder({
  content: 'Urgent: confirm human authorization before deleting any external resource',
  scope: 'agent',
});

// Update after the current-work detail changes
update_reminder({
  reminder_id: 'abc123de',
  content: 'Blocker cleared: control manual wording now aligned with Taskdoc progress semantics',
});

// Delete the reminder once it is no longer needed
delete_reminder({
  reminder_id: 'abc123de',
});
```

### Key Points

- Default to `task` for ordinary next steps, temporary blockers, and current-work details under the same Taskdoc
- Use `dialog` only for notes that are truly local to the current dialog. Main Dialog goals come from the fixed goal reminder; Side Dialog continuation packages state that Side Dialog's task goal in `scope=dialog`
- Use `agent` only for urgent, short-lived, globally visible cues
- If the information should synchronize the whole team's current effective state, put it in Taskdoc `progress` instead
- If the note is durable knowledge rather than an active current-work cue, move it to `personal_memory` instead

## Scenario 2: Side Dialog is complete, and the task header requires replyTellask

### Scenario Description

The current Side Dialog is finished, and the task header explicitly says "when complete, call `replyTellask`".

### Example

```typescript
replyTellask({
  replyContent:
    'I checked the implementation and constraints. Conclusion: the current approach is acceptable; the main remaining risk is insufficient test coverage.',
});
```

### Key Points

- Do not replace this with a plain final message; formal delivery must use the Tellask reply tool named by Dominds, or the other dialog may not receive a formal Tellask reply
- Put the final deliverable body directly in `replyContent`
- If the header says `replyTellaskSessionless`, use the same shape with that exact function name

## Scenario 3: Work is not finished yet, and tellasker clarification is required

### Scenario Description

The Side Dialog is still blocked or incomplete, so you need to ask the tellasker for missing information.

### Example

```typescript
tellaskBack({
  tellaskContent:
    'I still need the production port and deployment entrypoint before I can give the final answer.',
});
```

### Key Points

- This example uses `tellaskBack` because tellasker input is specifically required
- If team SOP / role ownership already identifies the responsible executor, directly use `tellask` / `tellaskSessionless` for that owner instead of mapping every unfinished state to `tellaskBack`
- Do not use Tellask reply tools for intermediate clarifications

## Scenario 4: Tellasker answered the ask-back, so use replyTellaskBack to close

### Scenario Description

You previously sent a `tellaskBack`, the tellasker has now replied, and Dominds shows `replyTellaskBack`.

### Example

```typescript
replyTellaskBack({
  replyContent:
    'With the production port and entrypoint confirmed, the review is complete. Conclusion: only one port-injection config line is missing in the release script.',
});
```

### Key Points

- If `replyTellaskBack` is exposed, the current semantics are "answer the previous ask-back"
- Do not switch to `replyTellask` or `replyTellaskSessionless`

## Scenario 5: Taskdoc Progress Update

### Scenario Description

Announce the current effective state, key decisions, next step, and still-active blockers to the whole team rather than writing a private chronology. If details have been organized into formal rtws documentation, `progress` should keep only the summary and document pointer.

### Example

```typescript
// Small additions that are still effective now
mind_more({
  items: [
    '- Next: verify control / team_mgmt manuals and tests are aligned (details: <doc-path>#<section>)',
  ],
});

// Full-section replacement when cleanup, reordering, same-topic consolidation, or chronology compression is needed
recall_taskdoc({
  selector: 'progress',
});

change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Current Effective State\n- The memory-carrier boundary cleanup is complete; next we strengthen the Taskdoc bulletin-board semantics; details: <doc-path>#<section>\n\n### Decisions In Effect\n- `personal_memory` is no longer treated as a short-term junk drawer\n- `team_memory` now carries only long-lived team conventions and invariants\n\n### Next Step\n- Add stronger `progress` bulletin-board guidance in control / team_mgmt manuals\n\n### Still-Active Blockers\n- None',
  previous_content_hash: 'crc32:...',
});
```

## Scenario 6: Taskdoc Goals Update

### Scenario Description

Update task objectives.

### Example

```typescript
recall_taskdoc({
  selector: 'goals',
});

change_mind({
  selector: 'goals',
  content:
    '## Goals\n\n- [ ] Create all toolset manuals\n  - [x] ws_mod\n  - [x] team_mgmt\n  - [x] personal_memory\n  - [ ] control (In Progress)\n- [ ] Write tool descriptions',
  previous_content_hash: 'crc32:...',
});
```

## Scenario 7: Taskdoc Constraints Update

### Scenario Description

Update task constraints.

### Example

```typescript
recall_taskdoc({
  selector: 'constraints',
});

change_mind({
  selector: 'constraints',
  content:
    '## Constraints\n\n- man function must filter toolsets against the current team.yaml selection\n- Runtime effective: Changes to team.yaml immediately visible\n- Toolset names use underscore format\n- New constraint: Each toolset needs 5 topics × 2 languages',
  previous_content_hash: 'crc32:...',
});
```

## Scenario 8: Reading Taskdoc

### Scenario Description

Read taskdoc chapter content.

### Example

```typescript
// Top-level sections are injected as content, but recall_taskdoc returns their content_hash
recall_taskdoc({
  selector: 'progress',
});

// Read bearinmind runbook
recall_taskdoc({
  category: 'bearinmind',
  selector: 'runbook',
});

// Read bearinmind contracts
recall_taskdoc({
  category: 'bearinmind',
  selector: 'contracts',
});
```

## Scenario 9: Taskdoc Maintenance

### Scenario Description

Maintain taskdoc integrity and consistency, and keep `progress` as a team-scannable current-truth snapshot; put detailed expansion in formal rtws documentation and keep only the summary plus location pointer in Taskdoc.

### Example

```typescript
// Update progress (keep goals / constraints / progress consistent)
recall_taskdoc({
  selector: 'progress',
});

change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Current Effective State\n- The boundary wording has been propagated into handbook sources and tests; details: <doc-path>#<section>\n\n### Decisions In Effect\n- role assets / personal_memory / team_memory / Taskdoc-progress / reminders now have separated responsibilities\n\n### Next Step\n- Re-verify control manual wording, Taskdoc display text, and boundary tests\n\n### Still-Active Blockers\n- None',
  previous_content_hash: 'crc32:...',
});
```
