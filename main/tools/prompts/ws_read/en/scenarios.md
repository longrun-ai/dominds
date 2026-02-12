# ws_read Usage Scenarios

## Scenario 1: View Directory Structure

### Scenario Description

View project directory structure.

### Example

```typescript
list_dir({
  path: 'dominds',
});
```

## Scenario 2: Read File Content

### Scenario Description

Read content of a specific file.

### Example

```typescript
read_file({
  path: 'dominds/docs/README.md',
});

// Read partial content
read_file({
  path: 'dominds/docs/README.md',
  range: '1~50',
});
```

## Scenario 3: Search Code

### Scenario Description

Search for specific content in code.

### Example

```typescript
// Search files containing "TODO"
ripgrep_files({
  pattern: 'TODO',
  path: 'dominds',
});

// Search and display snippets
ripgrep_snippets({
  pattern: 'TODO',
  path: 'dominds',
  context_after: 2,
});
```

## Scenario 4: Count Matches

### Scenario Description

Count number of occurrences.

### Example

```typescript
ripgrep_count({
  pattern: 'function',
  path: 'dominds/main',
});
```

## Scenario 5: Fixed String Search

### Scenario Description

Search for exact strings.

### Example

```typescript
ripgrep_fixed({
  literal: 'TODO:',
  path: 'dominds',
});
```

## Scenario 6: Search by File Type

### Scenario Description

Search in specific types of files.

### Example

```typescript
ripgrep_files({
  pattern: 'TODO',
  path: 'dominds',
  globs: ['*.ts', '*.tsx'],
});
```

## Scenario 7: Code Review

### Scenario Description

Find specific code patterns for review.

### Example

```typescript
// Find all console.log
ripgrep_snippets({
  pattern: 'console\\.log',
  path: 'dominds',
  context_before: 1,
  context_after: 1,
});
```
