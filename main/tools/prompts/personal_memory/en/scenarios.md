# personal_memory Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Maintain a Code Entry Map

### Scenario Description

Store the code entry points and file paths you repeatedly need, so future work starts faster.

### Example

**Save the entry map**

```typescript
add_personal_memory({
  path: 'project/dominds-entry-map',
  content:
    '## Dominds Entry Map\n\n- Team management runtime manual source: dominds/main/tools/team_mgmt.ts\n- team_mgmt manual entry: dominds/main/tools/team_mgmt-manual.ts\n- Built-in toolset registration: dominds/main/tools/builtins.ts\n- Prompt manual fragments: dominds/main/tools/prompts/**',
});
```

**Refine the map**

```typescript
replace_personal_memory({
  path: 'project/dominds-entry-map',
  content:
    '## Dominds Entry Map\n\n- Team management runtime manual source: dominds/main/tools/team_mgmt.ts\n- team_mgmt manual entry: dominds/main/tools/team_mgmt-manual.ts\n- Built-in toolset registration: dominds/main/tools/builtins.ts\n- Prompt manual fragments: dominds/main/tools/prompts/**\n- For `man()` rendering, also trace buildToolsetManualTools / renderTeamMgmtGuideContent',
});
```

## Scenario 2: Save Debug Search Templates

### Scenario Description

Save search patterns that repeatedly work well for you during debugging.

### Example

**Save the search template**

```typescript
add_personal_memory({
  path: 'debug/team-mgmt-search-queries',
  content:
    '## team_mgmt Search Templates\n\n- Find manual renderers: renderTeamManual|renderMindsManual|renderPermissionsManual\n- Find prompt fragments: rg -n "principles|scenarios" dominds/main/tools/prompts\n- Find manual tests: rg -n "team_mgmt-manual|toolsets/manual" dominds/tests',
});
```

**Update the template**

```typescript
replace_personal_memory({
  path: 'debug/team-mgmt-search-queries',
  content:
    '## team_mgmt Search Templates\n\n- Find manual renderers: renderTeamManual|renderMindsManual|renderPermissionsManual\n- Find prompt fragments: rg -n "principles|scenarios|index" dominds/main/tools/prompts\n- Find manual tests: rg -n "team_mgmt-manual|toolsets/manual|memory" dominds/tests',
});
```

## Scenario 3: Save External Research Strategy

### Scenario Description

Store durable research habits and search order that you want to reuse across future tasks.

### Example

**Save the strategy**

```typescript
add_personal_memory({
  path: 'research/search-strategies',
  content:
    '## Research Strategy\n\n- For product behavior, start with runtime source-of-truth before static docs\n- For UI copy, search i18n files and render sites together\n- For contracts/protocols, search shared/types first, then consumers',
});
```

**Refine the strategy**

```typescript
replace_personal_memory({
  path: 'research/search-strategies',
  content:
    '## Research Strategy\n\n- For product behavior, start with runtime source-of-truth before static docs\n- For UI copy, search i18n files and render sites together\n- For contracts/protocols, search shared/types first, then consumers\n- Only promote knowledge into memory after it proves durable and reusable',
});
```

## Scenario 4: Keep Long-Lived Working Preferences

### Scenario Description

Store stable preferences about how you work, so future generations stay more consistent.

### Example

```typescript
add_personal_memory({
  path: 'preferences/working-style',
  content:
    '## My Long-Lived Working Preferences\n\n- Find the source-of-truth before rewriting docs\n- When editing manuals, keep zh and en aligned, with zh semantics leading\n- Prefer `rg` to locate entry points before reading larger context',
});
```

## Scenario 5: Clean Up Outdated Memory

### Scenario Description

Delete memories that are stale, superseded, or no longer worth paying context cost for.

### Example

```typescript
drop_personal_memory({
  path: 'project/old-entry-map',
});
```

Or use `clear_personal_memory` to clear all memories (use with caution):

```typescript
clear_personal_memory({});
```
