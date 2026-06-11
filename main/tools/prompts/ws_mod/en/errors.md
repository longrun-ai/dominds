# ws_mod Error Handling

## Template (Errors)

### Error Chain (required)

1. Trigger Condition
2. Detection Signal
3. Recovery Steps
4. Success Criteria
5. Escalation Path (optional)

## Error Classification

| Stage  | Error Code                   | Description                              | Solution                                                           |
| ------ | ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| direct | `PATH_REQUIRED`              | File path is missing                     | Provide a non-empty relative file path                             |
| direct | `INVALID_ARGS`               | Tool arguments are invalid               | Fix the argument shape shown in the error message                  |
| direct | `INVALID_PATH`               | Path is outside rtws or otherwise bad    | Use a normalized relative path inside rtws                         |
| direct | `INVALID_FORMAT`             | Modification format is invalid           | Use the documented format for the selected tool                    |
| direct | `FILE_NOT_FOUND`             | File does not exist                      | Use `create=true` for append, or create/read the file first        |
| direct | `CONTENT_REQUIRED`           | Content empty but tool requires content  | Provide `content` or `pad_id/pad_range` for the edit               |
| direct | `ANCHOR_NOT_FOUND`           | Anchor line not found                    | Check anchor text correctness, or use `ripgrep_snippets` to locate |
| direct | `ANCHOR_AMBIGUOUS`           | Anchor has multiple matches              | Specify `occurrence` parameter to identify which match             |
| direct | `OCCURRENCE_OUT_OF_RANGE`    | occurrence out of range                  | Check if occurrence value is within `1~candidates_count` range     |
| direct | `OCCURRENCE_NOT_FOUND`       | Literal text has no matches              | Re-check `find` with `ripgrep_fixed` or inspect the file           |
| apply  | `FILE_CHANGED_SINCE_PREPARE` | Occurrence plan target file drifted      | Re-read and re-run `prepare_occurrence_replace`                    |
| apply  | `PLAN_NOT_FOUND`             | Occurrence plan expired/applied/missing  | Re-run `prepare_occurrence_replace`                                |
| write  | `ACCESS_DENIED`              | Reserved rtws path is hard-denied        | Use the dedicated tool/path listed in the error message            |
| write  | `FILE_EXISTS`                | File already exists (create_new_file)    | Use different path or delete existing file first                   |
| write  | `NOT_A_FILE`                 | Target path exists but is not a file     | Choose a different path or remove the non-file entry first         |
| write  | `STATS_MISMATCH`             | Whole-file overwrite snapshot mismatches | Re-read the file and retry with the latest snapshot                |
| write  | `SUSPICIOUS_DIFF`            | Diff/patch-looking content is undeclared | Declare `content_format`, or use a direct edit tool                |
| write  | `FAILED`                     | Filesystem or runtime failure            | Inspect the error text and fix the underlying condition            |

## Common Error Scenarios & Troubleshooting

### 1. Anchor-Related Errors

**ANCHOR_NOT_FOUND**

- Cause: Anchor text does not exist in file
- Troubleshooting: Use `ripgrep_snippets` to confirm anchor exists
- Note: Anchor matching is case-sensitive unless using `match: "contains"` (default)

**ANCHOR_AMBIGUOUS**

- Cause: Anchor appears multiple times in file
- Troubleshooting: Use `ripgrep_snippets` to see all match positions
- Solution: Add `occurrence` parameter (e.g., `occurrence: 2` for second match)

**OCCURRENCE_OUT_OF_RANGE**

- Cause: Specified occurrence greater than actual match count
- Solution: Change occurrence value to a valid range number

### Successful Notices

**NOT_MULTI_OCCURRENCE**

- Meaning: `prepare_occurrence_replace` selected only one occurrence; the tool still creates a valid plan
- Recommendation: use `file_range_edit` or `file_block_replace` for one-off edits; use `prepare_occurrence_replace` for multi-point same-literal replacement

### 2. Direct Edit Drift Errors

Direct edits write immediately unless `preview: true` is set. If a direct edit fails because anchors or line ranges no longer match your intent, re-read the current file, tighten the range/anchors, and retry with `preview: true, show_diff: true` if review is needed.

### 2.1 Occurrence Plan Drift Errors

**FILE_CHANGED_SINCE_PREPARE**

- Cause: `apply_occurrence_replace` was called after the target file changed
- Solution: Re-read the file, re-run `prepare_occurrence_replace`, then apply the fresh plan

**PLAN_NOT_FOUND**

- Cause: Plan expired, was already applied, or the process restarted
- Solution: Re-run `prepare_occurrence_replace`

### 3. Content Format Errors

**Default Reject Diff/Patch**

- Cause: Using `overwrite_entire_file`, body looks like diff/patch format but not declared
- Solution:
  - Option 1: If you really want to store diff/patch text literally, declare `content_format: "diff"` or `content_format: "patch"`
  - Option 2: If you only want to review an edit, use `preview: true, show_diff: true` on the direct tool

**STATS_MISMATCH**

- Cause: Whole-file overwrite used a stale snapshot
- Solution: Re-read the file and retry with the latest file stats/content

### 4. Permission Errors

**FAILED**

- Cause: Filesystem or runtime failure, including OS-level permission errors
- Solution: Inspect the error text, fix the underlying condition, then retry

**ACCESS_DENIED**

- Cause: Target path is a reserved rtws boundary such as `.minds/**`, root `.dialogs/**`, or `*.tsk/`
- Solution: For `.minds/**`, use `team_mgmt_*` tools when configured; for dialog debugging, reproduce under a nested rtws such as `ux-rtws/.dialogs/**`; do not edit `*.tsk/` packages through generic ws_mod tools

### 5. Path Errors

**FILE_NOT_FOUND**

- Cause: File path does not exist
- Solution:
  - If appending: use `create: true` parameter
  - Other cases: Create file first or check if path is correct

**NOT_A_FILE**

- Cause: Target path exists but points to a directory, symlink, or another non-file entry
- Solution: Use a different file path, or remove/rename the existing non-file entry before creating the file

## Error Prevention Tips

1. **Avoid dependent parallel writes**: Same-file writes are serialized internally, but multiple tool calls in one generation cannot see each other's outputs; read again before a dependent follow-up edit

2. **Read before write**: Call `read_file` first to get old file snapshot before using `overwrite_entire_file`

3. **Use unique anchors**: Avoid using too generic text as anchors; use `occurrence` to be explicit when needed

4. **Use preview deliberately**: Set `preview: true, show_diff: true` only when you need review output; otherwise direct tools write immediately

5. **Check output fields**: Especially `normalized.*` fields to confirm write behavior is as expected
