# ws_mod Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario Quick Reference

| Scenario                        | Recommended Tools       | Description                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------ |
| I want to view file content     | `read_file`             | With line number decoration, optional range      |
| I want to search and locate     | `ripgrep_snippets`      | Locate anchors by keywords                       |
| I want to create a new file     | `create_new_file`       | Allows empty content                             |
| I want to overwrite entire file | `overwrite_entire_file` | Requires providing old file snapshot             |
| I want to make small changes    | `file_range_edit`       | Direct precise line range edit                   |
| I want to append to end         | `file_append`           | Append to EOF                                    |
| I want to insert after a line   | `file_insert_after`     | Insert by anchor                                 |
| I want to insert before a line  | `file_insert_before`    | Insert by anchor                                 |
| I want to replace a block       | `file_block_replace`    | Double-anchor block replacement                  |
| I want to edit/move large text  | `pad_*` + file tools    | Prepare a pad, then write via `pad_id/pad_range` |

## Copy-Paste Ready Examples

### Append to End

```text
Call the function tool `file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\n- Use file_range_edit for precise ranges; use file_block_replace for anchor-delimited blocks.\n" }
```

### Line Range Replace

`content` can be empty string to indicate deletion:

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\nNew line 11\n" }
```

### Insert After Anchor

```text
Call the function tool `file_insert_after` with:
{ "path": "config.yaml", "anchor": "database:", "content": "  host: localhost\n  port: 5432\n" }
```

### Insert Before Anchor

```text
Call the function tool `file_insert_before` with:
{ "path": "config.yaml", "anchor": "---", "content": "# Configuration\n" }
```

### Double-Anchor Block Replace

```text
Call the function tool `file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\nNEW BLOCK LINE 2\n" }
```

### Create Empty File

```text
Call the function tool `create_new_file` with:
{ "path": "new-dir/new-file.md", "content": "" }
```

### Overwrite Entire File

```text
Call the function tool `read_file` with:
{ "path": "README.md" }
```

Then use the returned `total_lines` and `size_bytes`:

```text
Call the function tool `overwrite_entire_file` with:
{ "path": "README.md", "content": "# New Content\n...", "known_old_total_lines": 42, "known_old_total_bytes": 1234 }
```

### Large Body via Pad, Then File Write

```text
Call the function tool `pad_load_file_range` with:
{ "pad_id": "rewrite_doc", "path": "docs/spec.md", "intent": "Rewrite docs/spec.md structure and wording", "completion": "Delete after writing back and verifying", "source_note": "Loaded from docs/spec.md full file" }
```

Then refine against the line-numbered reminder body with `pad_edit` / `pad_insert` / `pad_delete_range`, and finally:

```text
Call the function tool `overwrite_entire_file` with:
{ "path": "docs/spec.md", "pad_id": "rewrite_doc", "known_old_total_lines": 42, "known_old_total_bytes": 1234, "content_format": "markdown" }
```

## Tool Selection Decision Tree

1. **Do you want to create a new file?**
   - Yes → `create_new_file`
   - No → Continue

2. **Do you want to completely overwrite old content?**
   - Yes, and body is large → `read_file` to get snapshot → prepare a pad with `pad_write` or `pad_load_file_range` → `overwrite_entire_file({ pad_id })`
   - Yes, and body is small → `read_file` to get snapshot → `overwrite_entire_file({ content })`
   - No → Continue

3. **Are you handling a large body or a body that needs multiple refinement steps?**
   - Yes → prepare a pad with `pad_write` or `pad_load_file_range`, fill `intent/completion/source_note`, then use the target file tool's `pad_id/pad_range`
   - No → Continue

4. **Do you know the specific line numbers?**
   - Yes → `file_range_edit`
   - No → Continue

5. **Can you locate by anchor?**
   - Yes → Choose `file_insert_after/before` or `file_block_replace` based on scenario
   - No → Consider using `ripgrep_snippets` to locate anchors first
