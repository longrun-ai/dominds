# team_mgmt Error Handling

## Template (Errors)

### Error Chain (required)

1. Trigger Condition
2. Detection Signal
3. Recovery Steps
4. Success Criteria
5. Escalation Path (optional)

## Common Errors

| Error Code                | Description                           | Solution                                        |
| ------------------------- | ------------------------------------- | ----------------------------------------------- |
| `FILE_NOT_FOUND`          | File does not exist                   | Use `create=true` or create file first          |
| `FILE_EXISTS`             | File already exists (create_new_file) | Use different path                              |
| `ANCHOR_NOT_FOUND`        | Anchor not found                      | Use `ripgrep_snippets` to confirm anchor exists |
| `ANCHOR_AMBIGUOUS`        | Anchor has multiple matches           | Specify `occurrence`                            |
| `OCCURRENCE_OUT_OF_RANGE` | occurrence out of range               | Check occurrence value                          |
| `HUNK_NOT_FOUND`          | Hunk expired/does not exist           | Re-prepare                                      |
| `WRONG_OWNER`             | Hunk planned by different member      | Can only apply hunks you generated              |
| `CONTEXT_REJECTED`        | File drifted                          | Re-prepare                                      |
| `PATH_OUTSIDE_MINDS`      | Path resolves outside .minds/         | Check path correctness                          |
| `VALIDATION_ERROR`        | team.yaml validation failed           | Fix configuration format                        |

## Path Errors

**PATH_OUTSIDE_MINDS**

- Cause: Path resolves outside `.minds/` after normalization
- Note: team_mgmt automatically prepends `.minds/` to path; any path that doesn't end up in `.minds/` is rejected
- Solution: Check if the provided path is correct

## Config Validation Errors

**VALIDATION_ERROR**

- Cause: `.minds/team.yaml` format is incorrect
- Solution:
  1. Run `team_mgmt_validate_team_cfg({})` to see specific errors
  2. Fix format issues in team.yaml
  3. Re-validate until no errors
  4. Clear Problems panel before proceeding

**MCP_VALIDATION_ERROR**

- Cause: `.minds/mcp.yaml` format errors, server config errors, or MCP runtime failures
- Solution:
  1. Run `team_mgmt_validate_mcp_cfg({})` to summarize specific errors
  2. Fix mcp.yaml or the relevant MCP server config
  3. Run `mcp_restart({"serverId":"<serverId>"})` when needed
  4. Re-validate until no errors and clear the Problems panel

## Error Prevention

1. **Must validate after config changes**: Run `team_mgmt_validate_team_cfg({})` after every `team.yaml` modification

2. **Must validate MCP config changes**: Run `team_mgmt_validate_mcp_cfg({})` after every `mcp.yaml` modification

3. **prepare → apply must be two steps**: Parallel execution in same step may cause apply to not see hunk

4. **Path auto-prepends `.minds/`**: Providing `team.yaml` auto-resolves to `.minds/team.yaml`

5. **Hunk has TTL**: Apply promptly to avoid hunk expiration

6. **Read before write**: Get snapshot via read before using overwrite
