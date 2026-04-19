# control Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Reminder Working Set Tracking

### Scenario Description

Use reminders for the current dialog's working set: next steps, blockers, and volatile details that are not meant to become the team's Taskdoc bulletin board.

### Example

```typescript
// Add a dialog-scoped working-set reminder
add_reminder({
  content: 'Next step: verify the control manual wording against Taskdoc progress semantics',
});

// Add a personal reminder only because this is a responsibility-linked cue
// that you should keep seeing in all later dialogs you lead
add_reminder({
  content: 'Preferred deploy smoke-check command: pnpm -C dominds run lint:types',
  scope: 'personal',
});

// Update after the local working-set detail changes
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

- Default to `dialog` for local next steps, temporary blockers, and volatile bridge details
- Use `personal` only when you should still see the note in all later dialogs you lead
- If the information should synchronize the whole team's current effective state, put it in Taskdoc `progress` instead
- If the note is durable knowledge rather than an active working-set cue, move it to `personal_memory` instead

## Scenario 2: Sideline is complete, and the assignment header requires replyTellask

### Scenario Description

The current sideline is finished, and the assignment header explicitly says "when complete, call `replyTellask`".

### Example

```typescript
replyTellask({
  replyContent:
    'I checked the implementation and constraints. Conclusion: the current approach is acceptable; the main remaining risk is insufficient test coverage.',
});
```

### Key Points

- Do not replace this with a plain final message
- Put the final deliverable body directly in `replyContent`
- If the header says `replyTellaskSessionless`, use the same shape with that exact function name

## Scenario 3: Work is not finished yet, and an upstream clarification is required

### Scenario Description

The sideline is still blocked or incomplete, so you need to ask upstream for missing information.

### Example

```typescript
tellaskBack({
  tellaskContent:
    'I still need the production port and deployment entrypoint before I can give the final answer.',
});
```

### Key Points

- This example uses `tellaskBack` because upstream input is specifically required
- If team SOP / role ownership already identifies the responsible executor, directly use `tellask` / `tellaskSessionless` for that owner instead of mapping every unfinished state to `tellaskBack`
- Do not use `replyTellask*` for intermediate clarifications

## Scenario 4: Upstream answered the ask-back, so use replyTellaskBack to close

### Scenario Description

You previously sent a `tellaskBack`, upstream has now replied, and runtime exposes `replyTellaskBack`.

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

Announce the current effective state, key decisions, next step, and still-active blockers to the whole team rather than writing a private chronology.

### Example

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Current Effective State\n- The memory-carrier boundary cleanup is complete; next we strengthen the Taskdoc bulletin-board semantics\n\n### Decisions In Effect\n- `personal_memory` is no longer treated as a short-term junk drawer\n- `team_memory` now carries only long-lived team conventions and invariants\n\n### Next Step\n- Add stronger `progress` bulletin-board guidance in control / team_mgmt manuals\n\n### Still-Active Blockers\n- None',
});
```

## Scenario 6: Taskdoc Goals Update

### Scenario Description

Update task objectives.

### Example

```typescript
change_mind({
  selector: 'goals',
  content:
    '## Goals\n\n- [ ] Create all toolset manuals\n  - [x] ws_mod\n  - [x] team_mgmt\n  - [x] personal_memory\n  - [ ] control (In Progress)\n- [ ] Write tool descriptions',
});
```

## Scenario 7: Taskdoc Constraints Update

### Scenario Description

Update task constraints.

### Example

```typescript
change_mind({
  selector: 'constraints',
  content:
    '## Constraints\n\n- man function must dynamically filter toolsets based on team.yaml\n- Runtime effective: Changes to team.yaml immediately visible\n- Toolset names use underscore format\n- New constraint: Each toolset needs 5 topics × 2 languages',
});
```

## Scenario 8: Reading Taskdoc

### Scenario Description

Read taskdoc chapter content.

### Example

```typescript
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

Maintain taskdoc integrity and consistency, and keep `progress` as a team-scannable current-truth snapshot.

### Example

```typescript
// Update progress (keep goals / constraints / progress consistent)
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Current Effective State\n- The boundary wording has been propagated into handbook sources and tests\n\n### Decisions In Effect\n- role assets / personal_memory / team_memory / Taskdoc-progress / reminders now have separated responsibilities\n\n### Next Step\n- Re-verify control manual wording, Taskdoc display text, and boundary tests\n\n### Still-Active Blockers\n- None',
});
```
