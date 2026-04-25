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

**Description:** Reminder id does not exist.

**Cause:**

- The reminder id you're trying to access doesn't exist
- The reminder has been deleted

**Solution:**

- Use the correct reminder id
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

### Q: What's the difference between dialog reminders, personal reminders, and memory?

A: `dialog` reminders are only for the current dialog's working set. `personal` reminders stay visible in all later dialogs you lead, but still belong to the working set rather than long-term knowledge. `personal_memory` is for durable facts and reusable knowledge saved to disk; if the information should synchronize the team's current effective state, key decisions, next step, or still-active blockers, write it to Taskdoc `progress` instead of a reminder.

### Q: How do I choose `personal` vs `dialog`?

A: Use `personal` only for responsibility-related reminders that you should keep seeing in all later dialogs you lead. Everything else should default to `dialog`.

### Q: Do do_mind / mind_more / change_mind / never_mind start a new course?

A: No. `do_mind` / `mind_more` / `change_mind` / `never_mind` only update Taskdoc content; they do not start a new course.

### Q: Are taskdoc updates immediately visible to all teammates?

A: Yes, taskdoc updates are immediately visible to all teammates.

### Q: Can I read other people's taskdoc?

A: Yes, use `recall_taskdoc` to read taskdoc chapter content.

### Q: Is there a limit on the number of reminders?

A: There's no strict limit, but it's recommended to keep the number of reminders reasonable (less than 20 recommended).

### Q: How do I view all current reminders?

A: The agent can access all visible reminders by `reminder_id` during response generation. That includes current-dialog reminders plus any visible personal/shared reminders available to you.
