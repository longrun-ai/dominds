### Failure Handling

Use the actual tool outcome and returned detail. Some tools emit structured `status` / `error` fields; others return an explanation. There is no universal error-code list shared by every read and search tool.

#### Missing or unreadable file

A wrong path, deleted file or OS permission failure can prevent a read. `read_file` returns a failed result with the underlying explanation; do not wait for a particular `FILE_NOT_FOUND` code before handling it. Verify the path with `list_dir`, retain the actual failure, and ask the authorized owner to repair permissions if needed.

#### Invalid input

Pass a single structured function call with the documented parameters. Do not paste tool-call text into `path` or `range`. Correct the parameter identified by the returned validation detail, then retry the intended operation.

#### Reserved-path or permission refusal

Generic `ws_read` tools cannot bypass these reserved boundaries: `.minds/**`, root `.dialogs/**`, and encapsulated `*.tsk/` packages. For team assets, use an authorized `team_mgmt_*` tool; for Taskdoc content, use Taskdoc tools. For runtime debugging, reproduce in an allowed nested workspace, for example `ux-rtws/.dialogs/**`. Keep within your authority when handling a refusal.

#### Search execution failure or incomplete scope

A malformed pattern, missing search path or failed ripgrep process can cause a failed result. Ripgrep execution failures can include `error: FAILED`; inspect the actual summary and diagnostics rather than assuming a `SEARCH_FAILED` code. An empty match set can be a successful search, while a partial-path failure means some requested scope was not inspected. Correct the specific path, pattern or permission problem and report any remaining incomplete scope.

#### Unsupported raw argument

When a ripgrep wrapper rejects a raw argument, remove it and use supported structured parameters such as `pattern`, `globs` and `path`. Do not bypass the wrapper's safety policy.

#### Repeated failure

Preserve the precise tool result, path, pattern and relevant limits. Ask the appropriate authorized teammate for help when the cause cannot be repaired within your authority. Do not repeat an unchanged failing operation until it happens to succeed or claim an unread file was inspected.
