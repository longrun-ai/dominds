# memory Usage Scenarios

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

In long-running tasks, you need to persist task progress to continue after restart.

### Example

**Add Task List**

```typescript
add_memory({
  path: 'project/i18n-tasks',
  content:
    '## TODO\n\n- [ ] Create ws_mod manual\n- [ ] Create team_mgmt manual\n- [ ] Create memory manual\n- [ ] Create control manual\n\n## In Progress\n- [ ] Create ws_mod manual [100%]',
});
```

**Update Task Progress**

```typescript
replace_memory({
  path: 'project/i18n-tasks',
  content:
    '## TODO\n\n- [ ] Create team_mgmt manual\n- [ ] Create memory manual\n- [ ] Create control manual\n\n## Completed\n- [x] Create ws_mod manual\n\n## In Progress\n- [ ] Create team_mgmt manual [50%]',
});
```

## Scenario 2: User Preferences Storage

### Scenario Description

Save user preferences, such as programming language, theme, etc.

### Example

**Save User Preferences**

```typescript
add_memory({
  path: 'user/preferences',
  content:
    '## User Preferences\n\n- Programming Language: TypeScript\n- Code Style: strict\n- Theme: dark\n- Auto Save: true',
});
```

**Update Preferences**

```typescript
replace_memory({
  path: 'user/preferences',
  content:
    '## User Preferences\n\n- Programming Language: TypeScript\n- Code Style: strict\n- Theme: light\n- Auto Save: true',
});
```

## Scenario 3: Context Information Preservation

### Scenario Description

In complex tasks, save important context information to avoid repeated queries.

### Example

**Save API Information**

```typescript
add_memory({
  path: 'context/api-endpoints',
  content:
    '## API Endpoints\n\n- User Login: POST /api/auth/login\n- Get User Info: GET /api/user/info\n- Update User Settings: PUT /api/user/settings\n\n## Authentication\n- Use Bearer Token\n- Validity: 24 hours',
});
```

**Save Tech Stack**

```typescript
add_memory({
  path: 'context/tech-stack',
  content:
    '## Tech Stack\n\n- Frontend: React + TypeScript\n- Backend: Node.js + Express\n- Database: PostgreSQL\n- Cache: Redis',
});
```

## Scenario 4: Meeting Notes

### Scenario Description

Save meeting highlights and decisions.

### Example

```typescript
add_memory({
  path: 'meeting/2024-01-15',
  content:
    '## Meeting Notes: 2024-01-15\n\n### Participants\n- @fullstack\n- @i18n\n- @ux\n\n### Agenda\n1. i18n manual creation plan\n2. man function UX improvements\n\n### Decisions\n- Prioritize creating ws_mod and team_mgmt manuals\n- man function supports fuzzy matching\n\n### TODO\n- @i18n: Create memory manual\n- @fullstack: Optimize man function',
});
```

## Scenario 5: Knowledge Base

### Scenario Description

Build a personal knowledge base and save learning notes.

### Example

```typescript
add_memory({
  path: 'knowledge/typescript-tips',
  content:
    '## TypeScript Tips\n\n### 1. Type Inference\nconst x = 1; // Type inferred as number\n\n### 2. Interface vs Type\n- Interface: Extensible, suitable for object types\n- Type: Supports union types, intersection types\n\n### 3. Strict Mode\nEnabling strict mode provides better type safety',
});
```

## Scenario 6: Temporary Notes

### Scenario Description

Temporarily save information to process later.

### Example

```typescript
add_memory({
  path: 'scratchpad/temp-notes',
  content:
    '## Temporary Notes\n\n- TODO: Check team.yaml configuration\n- TODO: Verify man function types\n- TODO: Update taskdoc progress',
});
```

**Delete after processing**

```typescript
drop_memory({
  path: 'scratchpad/temp-notes',
});
```

## Scenario 7: Cleaning Up Outdated Memory

### Scenario Description

Regularly clean up memories that are no longer needed.

### Example

```typescript
// View all current memories (agent can read)
// Delete unnecessary memories one by one
drop_memory({
  path: 'project/old-feature',
});
```

Or use `clear_memory` to clear all memories (use with caution):

```typescript
clear_memory({});
```
