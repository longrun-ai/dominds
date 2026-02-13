# control Error Handling

## Template (Errors)

### Error Chain (required)

1. Trigger Condition
2. Detection Signal
3. Recovery Steps
4. Success Criteria
5. Escalation Path (optional)

## Error Codes

### REMINDER_NOT_FOUND

**Description:** Reminder number does not exist.

**Cause:**

- The reminder number you're trying to access doesn't exist
- The reminder has been deleted

**Solution:**

- Use the correct reminder number
- First use `add_reminder` to create a reminder

### REMINDER_INVALID_POSITION

**Description:** Reminder position is invalid.

**Cause:**

- Position is out of valid range
- Position format is incorrect

**Solution:**

- Ensure position is between 1 and current reminder count
- By default, not specifying position will append to the end

### TASKDOC_CATEGORY_INVALID

**Description:** Taskdoc category is invalid.

**Cause:**

- Category directory doesn't exist
- Category name is incorrect

**Solution:**

- Use valid category name
- Common categories: goals, constraints, progress (top-level doesn't need category)

### TASKDOC_SELECTOR_INVALID

**Description:** Taskdoc selector is invalid.

**Cause:**

- Selector doesn't exist
- Selector format is incorrect

**Solution:**

- Use valid selector name
- Top-level sections: goals, constraints, progress
- Additional sections: Check taskdoc structure

### TASKDOC_UPDATE_FAILED

**Description:** Taskdoc update failed.

**Cause:**

- Write permission issues
- Insufficient disk space

**Solution:**

- Check disk space
- Check file system permissions

## Frequently Asked Questions

### Q: What's the difference between reminders and memory?

A: Reminders are session-level temporary information, automatically cleared after dialog ends; memory is persisted and saved to disk.

### Q: Does change_mind reset dialog rounds?

A: No. `change_mind` only updates taskdoc content, it doesn't reset dialog rounds.

### Q: Are taskdoc updates immediately visible to all teammates?

A: Yes, taskdoc updates are immediately visible to all teammates.

### Q: Can I read other people's taskdoc?

A: Yes, use `recall_taskdoc` to read taskdoc chapter content.

### Q: Is there a limit on the number of reminders?

A: There's no strict limit, but it's recommended to keep the number of reminders reasonable (less than 20 recommended).

### Q: How do I view all current reminders?

A: The agent can access all reminders during response generation. You can directly ask the agent what reminders it currently has.
