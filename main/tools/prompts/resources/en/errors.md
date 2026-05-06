# resources Error Handling

- Missing `resourceId`: call `list_resources` first.
- Static resource with `arguments`: remove the arguments.
- Template resource missing variables: pass every variable listed by `list_resources`.
- Fetch failure: inspect MCP server status and configuration.
