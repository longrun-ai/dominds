# team_memory Usage Scenarios

## Template (Scenarios)
### Scenario Format
- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Team Coding Standards

### Scenario Description

Save team's unified coding standards, visible to all members.

### Example

```typescript
add_shared_memory({
  path: 'team/conventions/code-style',
  content:
    '## TypeScript Coding Standards\n\n### Naming Rules\n- Variables/Functions: camelCase\n- Classes/Interfaces: PascalCase\n- Constants: UPPER_SNAKE_CASE\n\n### Type Rules\n- Forbidden: any type\n- Prefer interface over type\n- Must use strict mode\n\n### Code Organization\n- Max 200 lines per file\n- Group exports by function\n- Use JSDoc for comments',
});
```

## Scenario 2: Project Architecture Decisions

### Scenario Description

Record Architecture Decision Records (ADR) for new members to understand technology choices.

### Example

```typescript
add_shared_memory({
  path: 'team/adr/001-database',
  content:
    '## ADR-001: Use PostgreSQL as Primary Database\n\n### Status: Approved\n\n### Decision\nChoose PostgreSQL as primary database storage.\n\n### Rationale\n- Rich JSON support\n- Strong transaction support\n- Mature ecosystem\n\n### Consequences\n- Need to manage database migrations\n- Need regular backup strategy',
});
```

## Scenario 3: API Documentation Sharing

### Scenario Description

Share API documentation, visible and updatable by all team members.

### Example

````typescript
add_shared_memory({
  path: 'team/api/auth',
  content:
    '## Authentication API\n\n### Login\nPOST /api/auth/login\n\nRequest:\n```json\n{\n  "username": "string",\n  "password": "string"\n}\n```\n\nResponse:\n```json\n{\n  "token": "string",\n  "expiresIn": 86400\n}\n```\n\n### Refresh Token\nPOST /api/auth/refresh',
});
````

## Scenario 4: Current Sprint Status

### Scenario Description

Share current sprint status, including task progress and blocking issues.

### Example

```typescript
add_shared_memory({
  path: 'team/sprint/current',
  content:
    '## Sprint 15 Status\n\n### Progress\n- Completed: 8/15 tasks\n- In Progress: 4 tasks\n- Not Started: 3 tasks\n\n### Blocking Issues\n- API specification pending confirmation (owned by @alice)\n\n### Release Plan\n- Target Date: 2024-02-01\n- Regression Testing: 2024-01-30',
});
```

## Scenario 5: Tech Stack Documentation

### Scenario Description

Record project tech stack and dependency versions.

### Example

```typescript
add_shared_memory({
  path: 'team/tech-stack',
  content:
    '## Tech Stack\n\n### Frontend\n- React 18.2.0\n- TypeScript 5.3.0\n- Vite 5.0.0\n\n### Backend\n- Node.js 20.10.0\n- Express 4.18.0\n- PostgreSQL 15.0\n\n### Dev Tools\n- ESLint 8.55.0\n- Prettier 3.1.0\n- Jest 29.7.0',
});
```

## Scenario 6: Team Member Information

### Scenario Description

Record team member responsibilities and contact information.

### Example

```typescript
add_shared_memory({
  path: 'team/members',
  content:
    '## Team Members\n\n### @fullstack\n- Responsibility: Backend development, API design\n- Expertise: Node.js, PostgreSQL\n\n### @i18n\n- Responsibility: Internationalization, Documentation\n- Expertise: Multi-language, Content strategy\n\n### @ux\n- Responsibility: User Experience, Design\n- Expertise: UI/UX, Figma',
});
```

## Scenario 7: Maintaining Team Knowledge Base

### Scenario Description

Team shared knowledge base, including common problem solutions.

### Example

```typescript
add_shared_memory({
  path: 'team/kb/docker-debug',
  content:
    '## Docker Debugging Tips\n\n### View Container Logs\ndocker logs <container_id>\n\n### Enter Container for Debugging\ndocker exec -it <container_id> sh\n\n### Check Container Network\ndocker network inspect <network_name>\n\n### Common Issues\n- Port conflict: Check docker-compose.yml port mapping\n- Memory insufficient: Adjust docker-compose.yml memory limit',
});
```
