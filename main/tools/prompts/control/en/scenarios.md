# control Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Task Progress Tracking

### Scenario Description

Use reminders to track current task progress.

### Example

```typescript
// Add task reminder
add_reminder({
  content: 'Current task: Creating i18n manual [In Progress]',
});

// Add a personal reminder only because this is a responsibility-linked cue
// that you should keep seeing in all later dialogs you lead
add_reminder({
  content: 'Preferred deploy smoke-check command: pnpm -C dominds run lint:types',
  scope: 'personal',
});

// Update after task completion
update_reminder({
  reminder_id: 'abc123de',
  content: 'Completed: Creating i18n manual [Done]',
});

// Delete completed reminder
delete_reminder({
  reminder_id: 'abc123de',
});
```

### Key Points

- Default to `dialog` for current-task progress and temporary blockers
- Use `personal` only when you should still see the note in all later dialogs you lead
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

- Use `tellaskBack` while the work is still unfinished
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

Update task progress to taskdoc.

### Example

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual\n- [x] Create team_mgmt manual\n- [x] Create personal_memory manual\n\n### In Progress\n- [ ] Create control manual [50%]\n\n### Pending Improvements\n- [ ] Write tool descriptions',
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

Maintain taskdoc integrity and consistency.

### Example

```typescript
// Update progress (keep goals and progress consistent)
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual [100%]\n- [x] Create team_mgmt manual [100%]\n- [x] Create personal_memory manual [100%]\n\n### In Progress\n- [ ] Create control manual [60%]\n\n### Next Steps\n- Complete control manual\n- Create os manual',
});
```
