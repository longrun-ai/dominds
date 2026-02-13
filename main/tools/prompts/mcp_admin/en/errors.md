# mcp_admin Error Handling

## Template (Errors)
### Error Chain (required)
1) Trigger Condition
2) Detection Signal
3) Recovery Steps
4) Success Criteria
5) Escalation Path (optional)

## Error Codes

### MCP_NOT_FOUND

**Description:** MCP service doesn't exist.

**Cause:**

- Specified MCP service identifier doesn't exist
- MCP service has been deleted

**Solution:**

- Check if MCP service identifier is correct
- Confirm if MCP service is registered

### MCP_NOT_RUNNING

**Description:** MCP service is not running.

**Cause:**

- MCP service has stopped
- MCP service hasn't been started

**Solution:**

- Start MCP service
- Check MCP service status

### MCP_RESTART_FAILED

**Description:** MCP service restart failed.

**Cause:**

- Service is busy
- Insufficient resources

**Solution:**

- Wait and retry
- Release some resources and retry

### MCP_RELEASE_FAILED

**Description:** MCP lease release failed.

**Cause:**

- Lease doesn't exist
- Insufficient permissions

**Solution:**

- Check lease status
- Contact administrator

### ENV_NOT_FOUND

**Description:** Environment variable doesn't exist.

**Cause:**

- Environment variable not set
- Environment variable name is incorrect

**Solution:**

- Check environment variable name
- Set required environment variable

## Frequently Asked Questions

### Q: What is an MCP lease?

A: MCP lease is a mechanism for managing MCP connection resources, ensuring proper allocation and release of resources.

### Q: Why do I need to release MCP lease?

A: Not releasing leases causes resource leaks, which may affect other services using MCP.

### Q: What to do if MCP service cannot connect?

A: Try the following steps:

1. Check network connection
2. Restart MCP service
3. Check authentication configuration

### Q: How to view MCP service status?

A: You can view MCP service status through related commands, or check logs for detailed information.
