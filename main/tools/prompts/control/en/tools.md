# control Tool Reference

## Template (Tools)

### How to Read

- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (refer to schema)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Tool List

### 1. add_reminder

Add reminder.

**Parameters:**

- `content` (required): Reminder content
- `position` (optional): Insert position (1-based, default append)

**Returns:**

```yaml
status: ok|error
reminder_no: <reminder number>
content: <reminder content>
position: <insert position>
created_at: <creation timestamp>
```

### 2. delete_reminder

Delete specified reminder.

**Parameters:**

- `reminder_no` (required): Reminder number (1-based)

**Returns:**

```yaml
status: ok|error
reminder_no: <reminder number>
deleted_at: <deletion timestamp>
```

**Errors:**

- `REMINDER_NOT_FOUND`: Reminder number does not exist

### 3. update_reminder

Update reminder content.

**Parameters:**

- `reminder_no` (required): Reminder number (1-based)
- `content` (required): New reminder content

**Returns:**

```yaml
status: ok|error
reminder_no: <reminder number>
content: <new reminder content>
updated_at: <update timestamp>
```

**Errors:**

- `REMINDER_NOT_FOUND`: Reminder number does not exist

### 4. change_mind

Update taskdoc chapter.

**Parameters:**

- `selector` (required): Chapter selector (goals/constraints/progress)
- `content` (required): New content (full section replacement)

**Returns:**

```yaml
status: ok|error
selector: <chapter selector>
updated_at: <update timestamp>
```

**Characteristics:**

- Each call replaces entire chapter
- Does not reset dialog rounds
- Changes visible to all teammates
- Constraint rule: `constraints` must include only task-specific hard requirements; do not repeat global rules. If a duplicate is found, delete it and inform the user

### 5. recall_taskdoc

Read taskdoc chapter.

**Parameters:**

- `category` (required): Category directory
- `selector` (required): Chapter selector

**Returns:**

```yaml
status: ok|error
category: <category>
selector: <selector>
content: <chapter content>
retrieved_at: <retrieval timestamp>
```

## Usage Examples

### Add Reminder

```typescript
add_reminder({
  content: 'Waiting for @fullstack to confirm API design',
  position: 1,
});
```

### Delete Reminder

```typescript
delete_reminder({
  reminder_no: 1,
});
```

### Update Reminder

```typescript
update_reminder({
  reminder_no: 1,
  content: 'Waiting for @fullstack to confirm API design [Confirmed]',
});
```

### Update Taskdoc Progress

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual\n- [x] Create team_mgmt manual\n\n### In Progress\n- [ ] Create memory manual [80%]\n\n### Not Started\n- [ ] Create control manual',
});
```

### Read Taskdoc Chapter

```typescript
recall_taskdoc({
  category: 'bearinmind',
  selector: 'runbook',
});
```

## YAML Output Contract

All tool outputs use YAML format for programmatic processing:

- `status`: Operation status, `ok` for success, `error` for failure
- Other fields: Additional information for specific operations

On error, returns:

```yaml
status: error
error_code: <error code>
message: <error message>
```
