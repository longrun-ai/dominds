# control Usage Scenarios

## Scenario 1: Task Progress Tracking

### Scenario Description

Use reminders to track current task progress.

### Example

```typescript
// Add task reminder
add_reminder({
  content: 'Current task: Creating i18n manual [In Progress]',
});

// Update after task completion
update_reminder({
  reminder_no: 1,
  content: 'Completed: Creating i18n manual [Done]',
});

// Delete completed reminder
delete_reminder({
  reminder_no: 1,
});
```

## Scenario 2: Blocking Issue Recording

### Scenario Description

Record blocking issues encountered.

### Example

```typescript
add_reminder({
  content: 'Blocked: Waiting for backend API documentation confirmation',
});

// After blocking resolved
update_reminder({
  reminder_no: 1,
  content: 'Blocking resolved: Backend API documentation confirmed',
});
```

## Scenario 3: Taskdoc Progress Update

### Scenario Description

Update task progress to taskdoc.

### Example

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual\n- [x] Create team_mgmt manual\n- [x] Create memory manual\n\n### In Progress\n- [ ] Create control manual [50%]\n\n### Pending Improvements\n- [ ] Write tool descriptions',
});
```

## Scenario 4: Taskdoc Goals Update

### Scenario Description

Update task objectives.

### Example

```typescript
change_mind({
  selector: 'goals',
  content:
    '## Goals\n\n- [ ] Create all toolset manuals\n  - [x] ws_mod\n  - [x] team_mgmt\n  - [x] memory\n  - [ ] control (In Progress)\n- [ ] Write tool descriptions',
});
```

## Scenario 5: Taskdoc Constraints Update

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

## Scenario 6: Reading Taskdoc

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

## Scenario 7: Taskdoc Maintenance

### Scenario Description

Maintain taskdoc integrity and consistency.

### Example

```typescript
// Update progress (keep goals and progress consistent)
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual [100%]\n- [x] Create team_mgmt manual [100%]\n- [x] Create memory manual [100%]\n\n### In Progress\n- [ ] Create control manual [60%]\n\n### Next Steps\n- Complete control manual\n- Create os manual',
});
```
