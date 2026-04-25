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

| Function                  | Minimal parameter contract   | When runtime exposes it                                                                                     | Effect                                                         |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `replyTellask`            | `{ replyContent: string }`   | Current Side Dialog comes from a sessioned `tellask` and is ready for final delivery                        | Delivers the final result for the current tellask session      |
| `replyTellaskSessionless` | `{ replyContent: string }`   | Current Side Dialog comes from a one-shot `tellaskSessionless` and is ready for final delivery              | Delivers the final result for the current one-shot tellask     |
| `replyTellaskBack`        | `{ replyContent: string }`   | Current dialog holds an unresolved `tellaskBack` reply directive                                            | Delivers the final answer to the tellasker ask-back            |
| `tellaskBack`             | `{ tellaskContent: string }` | Current Side Dialog must ask the tellasker back, and existing team SOP cannot directly assign another owner | Sends a follow-up request to the tellasker; not final delivery |

### Minimal Usage Rules

- Focus on doing the current task correctly first; only move into `reply*` closure when final tellasker delivery is actually ready
- Call whichever `reply*` runtime currently exposes; do not switch to another reply variant by yourself
- If the assignment header explicitly names a reply function, follow that exact name
- Put only the final deliverable body in `replyContent`; do not wrap it in meta-explanations like "I am now calling replyTellask"
- If you emit plain text instead of the reply tool, runtime may inject a temporary `role=user` reminder telling you to use the correct reply function

### 1. add_reminder

Add reminder.

Use when:

- Adding a new temporary working-set item
- Before `clear_mind`, the Main Dialog first records undocumented discussion details the next course needs to know into Taskdoc, then creates continuation-package notes; a Side Dialog directly maintains sufficiently detailed continuation-package reminders. When the current course is already under caution/critical remediation, Side Dialog reminder length has no technical limit and rough bridge notes are acceptable

**Parameters:**

- `content` (required): Reminder content
- `position` (optional): Insert position (1-based, default append; dialog scope only)
- `scope` (optional): `dialog` or `personal`; default is `dialog`. Use `personal` only when you should keep seeing this reminder in all later dialogs you lead; otherwise keep it `dialog`.

**Returns:**

```yaml
status: ok|error
reminder_id: <reminder id>
content: <reminder content>
position: <insert position>
created_at: <creation timestamp>
```

### 2. delete_reminder

Delete specified reminder.

**Parameters:**

- `reminder_id` (required): Reminder id

**Returns:**

```yaml
status: ok|error
reminder_id: <reminder id>
deleted_at: <deletion timestamp>
```

**Errors:**

- `REMINDER_NOT_FOUND`: Reminder id does not exist

### 3. update_reminder

Update reminder content.

Use when:

- Compressing / merging existing reminders
- Rewriting pre-clear resume info into continuation-package notes
- Removing details that have already been promoted into Taskdoc

**Parameters:**

- `reminder_id` (required): Reminder id
- `content` (required): New reminder content

**Returns:**

```yaml
status: ok|error
reminder_id: <reminder id>
content: <new reminder content>
updated_at: <update timestamp>
```

**Errors:**

- `REMINDER_NOT_FOUND`: Reminder id does not exist

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

### 5. do_mind

Create a new Taskdoc section. It fails if the target section already exists.

**Parameters:**

- `selector` (required): Chapter selector (goals/constraints/progress)
- `category` (optional): Extra section directory; with `selector`, targets `<category>/<selector>.md`
- `content` (required): New section content

**Characteristics:**

- Create-only: it does not overwrite existing content
- Use this for missing resident sections or new extra sections that preserve details without touching existing Taskdoc text
- If the target already exists and only needs small additions, use `mind_more`; if it needs a full rewrite/merge, use `change_mind`
- Does not start a new course
- Changes visible to all teammates

### 6. change_mind

Update taskdoc chapter.

**Parameters:**

- `selector` (required): Chapter selector (goals/constraints/progress)
- `category` (optional): Extra section directory; with `selector`, targets `<category>/<selector>.md`
- `content` (required): New content (full section replacement)

**Returns:**

```yaml
status: ok|error
selector: <chapter selector>
updated_at: <update timestamp>
```

**Characteristics:**

- Each call replaces an existing entire chapter; it does not create missing sections
- Does not start a new course
- Changes visible to all teammates
- Constraint rule: `constraints` must include only task-specific hard requirements; do not repeat global rules. If a duplicate is found, delete it and inform the user

### 7. mind_more

Append entries to a Taskdoc section; defaults to `progress`, reducing full-section replacement pressure.

**Parameters:**

- `items` (required): Entries to append; each item must be a non-empty string
- `sep` (optional): Separator between existing content and new content, and between entries. Defaults to `\n`
- `selector` (optional): Chapter selector. Defaults to `progress`; use `goals` / `constraints` / `progress`
- `category` (optional): Extra section directory; with `selector`, targets `<category>/<selector>.md`

**Example:**

```typescript
mind_more({
  items: [
    '- Next: review verification results (details: <doc-path>#<section>)',
    '- Blocker: API acceptance criteria pending',
  ],
});
```

**Characteristics:**

- Append-only: it does not deduplicate, rewrite, or compress old content
- Good for adding one or two still-effective states, decisions, next steps, or blockers to `progress`
- Not for appending every investigation step, long log, full plan, or acceptance record as a chronology; those details belong in formal rtws documentation, while Taskdoc keeps the summary and document pointer
- If stale entries must be removed, reordered, or compressed, use `change_mind` for a full-section replacement; if a whole section file should be deleted, use `never_mind`
- When one topic already has several phase notes, prefer `change_mind` to merge them into a concise current announcement instead of continuing to call `mind_more`

### 8. never_mind

Delete a Taskdoc section file.

**Parameters:**

- `selector` (required): Chapter selector. Top-level sections use `goals` / `constraints` / `progress`
- `category` (optional): Extra section directory; with `selector`, targets `<category>/<selector>.md`

**Characteristics:**

- Deletes only the whole section file; it does not edit content
- Use it only when the whole section is no longer valid. If you only need to remove stale entries or compress structure, prefer `change_mind` with the cleaned full section
- Does not start a new course

### 9. recall_taskdoc

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
  reminder_id: 'abc123de',
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
  reminder_id: 'abc123de',
});
```

### Update Reminder

```typescript
update_reminder({
  reminder_id: 'abc123de',
  content: 'Waiting for @fullstack to confirm API design [Confirmed]',
});
```

### Update Taskdoc Progress

```typescript
mind_more({
  items: [
    '- Next: strengthen the bulletin-board semantics of Taskdoc `progress` (details: <doc-path>#<section>)',
  ],
});
```

### Replace Taskdoc Progress

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### Current Effective State\n- The handbook boundary split is now agreed: role assets / personal long-lived experience / Taskdoc-progress / reminders; details: <doc-path>#<section>\n\n### Decisions In Effect\n- `persona / knowhow / pitfalls` no longer absorb daily member experience\n- `personal_memory` is reserved for one member\\'s reusable long-lived experience\n\n### Next Step\n- Strengthen the bulletin-board semantics of Taskdoc `progress`\n\n### Still-Active Blockers\n- None',
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
- If the current course is already under caution/critical remediation: the Main Dialog first records undocumented discussion details the next course needs to know into the appropriate Taskdoc sections, then keeps necessary continuation-package reminders; a Side Dialog must not maintain Taskdoc or draft Taskdoc update proposals, and should directly maintain sufficiently detailed continuation-package reminders with no technical length limit. Rough multi-reminder bridge notes are acceptable and should be reconciled as the first step only after the system actually starts the new course
- Keep only details still not covered by Taskdoc; do not repeat team-shared status. If the team needs “where we are now / which decisions are in effect / what is next / which blockers still hold”, write it back to Taskdoc `progress`
- Do not paste long logs, large tool outputs, or raw material into reminders
