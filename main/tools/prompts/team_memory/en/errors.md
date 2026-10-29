# team_memory: handling failures

The memory tools return a structured failure outcome with explanatory content. They do not expose a fixed catalog of MEMORY\_\* error codes. Inspect the actual result before deciding how to recover.

## Existing or missing memory

An add fails if its path already exists. Read the existing memory and use the corresponding replace tool when updating it; do not create another path just to bypass that check. Replace and delete require an existing path. If the intended memory is absent, confirm the intended operation before adding it.

## Invalid input

Provide a nonempty relative path without `..`, and nonempty content for add/replace. There is no letters-only path rule, fixed 255-character path limit, or fixed 1 MB content limit in Dominds. The underlying filesystem may still reject a name or path.

## Storage failures

Inspect the reported filesystem error and the relevant path, available storage, and permissions. Correct the cause before retrying. After an uncertain write, inspect the current file before repeating an operation. Keep memories concise because they contribute to future context, rather than relying on an invented size limit.

## Ownership and deletion

Team memory is shared among members granted the relevant tools. Coordinate edits to avoid overwriting another member's facts. Clearing the shared store affects the team, and the tools do not provide undo.
