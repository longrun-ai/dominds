# team_mgmt Usage Scenarios

## Template (Scenarios)
### Scenario Format
- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Common Scenarios

### 1. Read Team Configuration

```text
Call the function tool `team_mgmt_read_file` with:
{ "path": "team.yaml" }
```

### 2. Modify Team Configuration (Two Steps)

**Step 1: Prepare**

```text
Call the function tool `team_mgmt_prepare_file_range_edit` with:
{ "path": "team.yaml", "range": "10~12", "content": "new-content: value" }
```

**Step 2: Apply (must be separate step)**

```text
Call the function tool `team_mgmt_apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

### 3. Create New Mind File

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```

Or create with initial content:

```text
Call the function tool `team_mgmt_prepare_file_append` with:
{ "path": "team/domains/new-domain.md", "content": "# New Domain\n\nContent here.", "create": true }
```

Then apply.

### 4. Validate Configuration

After modifying `.minds/team.yaml`, always run:

```text
Call the function tool `team_mgmt_validate_team_cfg` with:
{}
```

Ensure no errors in Problems panel before proceeding.

### 5. Search Team Configuration

```text
Call the function tool `team_mgmt_ripgrep_snippets` with:
{ "pattern": "member", "path": "team.yaml" }
```

### 6. Overwrite Entire Config File

```text
Call the function tool `team_mgmt_read_file` with:
{ "path": "team.yaml" }
```

Get `total_lines` and `size_bytes`, then:

```text
Call the function tool `team_mgmt_overwrite_entire_file` with:
{ "path": "team.yaml", "content": "members:\n  - id: user1\n    name: User One\n", "known_old_total_lines": 10, "known_old_total_bytes": 256 }
```

## Decision Tree

1. **What type of file are you operating on?**
   - `team.yaml` or other config → Continue
   - Mind file → Continue

2. **Do you want to create a new file?**
   - Yes → `team_mgmt_create_new_file`
   - No → Continue

3. **Do you want to completely overwrite?**
   - Yes → `team_mgmt_read_file` for snapshot → `team_mgmt_overwrite_entire_file`
   - No → Continue

4. **Do you know the line numbers?**
   - Yes → `team_mgmt_prepare_file_range_edit` → `team_mgmt_apply_file_modification`
   - No → Continue

5. **Can you locate by anchor?**
   - Yes → `team_mgmt_prepare_file_insert_after/before` or `team_mgmt_prepare_file_block_replace`
   - Search for anchor → Use `team_mgmt_ripgrep_snippets` first

## Important Reminders

- Run `team_mgmt_validate_team_cfg({})` after every `team.yaml` modification and confirm no errors
- When using prepare/apply, prepare and apply must be in separate steps
- All paths are automatically prefixed with `.minds/`
