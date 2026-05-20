fs_read is Dominds' local-filesystem read-only toolset for reading and searching files outside rtws:

- Directory listing
- File reading
- Symlink inspection
- Content searching

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/fs.ts`, `dominds/main/tools/txt.ts`, `dominds/main/tools/picture.ts`, `dominds/main/tools/ripgrep.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Difference from ws_read

`fs_read` exposes the same read-oriented capabilities as `ws_read`, but without the rtws path restriction.
