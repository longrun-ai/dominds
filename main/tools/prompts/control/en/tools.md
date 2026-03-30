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

## Inter-dialog Reply Quick Reference

The **tool descriptions themselves** for these functions intentionally stay minimal and spec-like. This section carries the smallest practical lookup for when they appear and how to choose among them.

| Function                  | Minimal parameter contract   | When runtime exposes it                                                                       | Effect                                                     |
| ------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `replyTellask`            | `{ replyContent: string }`   | Current sideline comes from a sessioned `tellask` and is ready for final delivery             | Delivers the final result for the current tellask session  |
| `replyTellaskSessionless` | `{ replyContent: string }`   | Current sideline comes from a one-shot `tellaskSessionless` and is ready for final delivery   | Delivers the final result for the current one-shot tellask |
| `replyTellaskBack`        | `{ replyContent: string }`   | Current dialog holds an unresolved `tellaskBack` reply directive                              | Delivers the final answer to the upstream ask-back         |
| `tellaskBack`             | `{ tellaskContent: string }` | Current sideline is not done yet and needs clarification / ask-back / blocked-state reporting | Sends a follow-up request upstream; not final delivery     |

### Minimal Usage Rules

- Focus on doing the current task correctly first; only move into `reply*` closure when final upstream delivery is actually ready
- Call whichever `reply*` runtime currently exposes; do not switch to another reply variant by yourself
- If the assignment header explicitly names a reply function, follow that exact name
- Put only the final deliverable body in `replyContent`; do not wrap it in meta-explanations like "I am now calling replyTellask"
- If you emit plain text instead of the reply tool, runtime may inject a temporary `role=user` reminder telling you to use the correct reply function

### 1. add_reminder

Add reminder.

Use when:

- Adding a new temporary working-set item
- Creating continuation-package notes before `clear_mind`; rough bridge notes are acceptable when context is already degraded

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

Use when:

- Compressing / merging existing reminders
- Rewriting pre-clear resume info into continuation-package notes
- Removing details that have already been promoted into Taskdoc

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

### 4. clear_mind

Start a new dialog course.

Use when:

- The current course has too much context noise and you want to continue in a fresh course
- The continuation info is already stored in existing reminders, so `clear_mind({})` is enough
- One extra continuation note is still missing from reminders, so you want to carry it with `reminder_content`

**Parameters:**

- `reminder_content` (optional): Extra continuation note; pass it only when that note is not already captured in existing reminders

**Returns:**

```yaml
status: ok|error
```

**Minimal Rules:**

- If you just finished writing the same continuation info via `add_reminder` / `update_reminder`, prefer `clear_mind({})`
- If you are not sure whether it duplicates something, a small amount of redundancy is acceptable; do not risk losing information just to force perfect dedupe

### 5. change_mind

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

### 6. recall_taskdoc

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

### Switch Course and Reuse Existing Reminder

```typescript
update_reminder({
  reminder_no: 1,
  content:
    'In the next course, run smoke first, then re-check the release script against port-injection config.',
});

clear_mind({});
```

### Switch Course and Add One Extra Continuation Note

```typescript
clear_mind({
  reminder_content:
    'In the next course, run smoke first, then re-check the release script against port-injection config.',
});
```

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
    '## Progress\n\n### Completed\n- [x] Create ws_mod manual\n- [x] Create team_mgmt manual\n\n### In Progress\n- [ ] Create personal_memory manual [80%]\n\n### Not Started\n- [ ] Create control manual',
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

## Documentation Split

- Tool descriptions: minimal spec only
- This chapter: quick lookup and input/output skeleton
- `principles`: boundaries and decision rules
- `scenarios`: copy-ready situational examples
- `clear_mind` is designed to preserve continuation info first; correct guidance is preferred over programmatic dedupe

## Reminder Content Guidance

- Normal reminders should stay concise, fresh, and directly actionable; often 1-3 items total
- For a continuation package, use structured notes by default: next step, key pointers, run/verify, easy-to-lose volatile details
- If the current course is already under caution/critical remediation, rough multi-reminder bridge notes are acceptable; in the current course only preserve info + `clear_mind`, and reconcile them as the first step only after the system actually starts the new course
- Keep only details not already covered by Taskdoc; do not repeat team-shared status
- Do not paste long logs, large tool outputs, or raw material into reminders
