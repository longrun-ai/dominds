# ws_mod Usage Scenarios

## Scenario Quick Reference

| Scenario                        | Recommended Tools                                        | Description                                 |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| I want to view file content     | `read_file`                                              | With line number decoration, optional range |
| I want to search and locate     | `ripgrep_snippets`                                       | Locate anchors by keywords                  |
| I want to create a new file     | `create_new_file`                                        | Allows empty content                        |
| I want to overwrite entire file | `overwrite_entire_file`                                  | Requires providing old file snapshot        |
| I want to make small changes    | `prepare_file_range_edit` + `apply_file_modification`    | By line number range                        |
| I want to append to end         | `prepare_file_append` + `apply_file_modification`        | Append to EOF                               |
| I want to insert after a line   | `prepare_file_insert_after` + `apply_file_modification`  | Insert by anchor                            |
| I want to insert before a line  | `prepare_file_insert_before` + `apply_file_modification` | Insert by anchor                            |
| I want to replace a block       | `prepare_file_block_replace` + `apply_file_modification` | Double-anchor block replacement             |

## Copy-Paste Ready Examples

### Append to End

```text
Call the function tool `prepare_file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\n- Use prepare_* + apply_file_modification for incremental edits.\n" }
```

Then in the next round:

```text
Call the function tool `apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

### Line Range Replace

`content` can be empty string to indicate deletion:

```text
Call the function tool `prepare_file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\nNew line 11\n" }
```

### Insert After Anchor

```text
Call the function tool `prepare_file_insert_after` with:
{ "path": "config.yaml", "anchor": "database:", "content": "  host: localhost\n  port: 5432\n" }
```

### Insert Before Anchor

```text
Call the function tool `prepare_file_insert_before` with:
{ "path": "config.yaml", "anchor": "---", "content": "# Configuration\n" }
```

### Double-Anchor Block Replace

```text
Call the function tool `prepare_file_block_replace` with:
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

## Tool Selection Decision Tree

1. **Do you want to create a new file?**
   - Yes → `create_new_file`
   - No → Continue

2. **Do you want to completely overwrite old content?**
   - Yes → `read_file` to get snapshot → `overwrite_entire_file`
   - No → Continue

3. **Do you know the specific line numbers?**
   - Yes → `prepare_file_range_edit` → `apply_file_modification`
   - No → Continue

4. **Can you locate by anchor?**
   - Yes → Choose `prepare_file_insert_after/before` or `prepare_file_block_replace` based on scenario
   - No → Consider using `ripgrep_snippets` to locate anchors first
