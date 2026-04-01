# Daemon Runner and Recoverable Scrollback

Chinese version: [中文版](./daemon-cmd-runner.zh.md)

This document defines a replacement design for the `os` toolset's daemon mechanism. The current model can rediscover a previously launched daemon after a Dominds crash/restart, but it cannot recover the daemon's captured stdout/stderr scrollback because those buffers live in the Dominds main process memory. Once the main process is gone, `get_daemon_output` loses its source of truth.

The new design does not patch around that limitation. It moves daemon ownership, scrollback ownership, output queries, and stop control into a dedicated per-daemon runner process that survives a Dominds main-process restart.

This is a design document, not an implementation plan.

---

## Goals

- Keep daemon scrollback readable after the Dominds main process crashes and comes back.
- Move daemon ownership out of the Dominds main process and into an external `cmd_runner`.
- Use one execution path for both short-lived and long-lived commands.
- Replace the current `get_daemon_output(stream=...)` contract with a friendlier API that can fetch both streams at once.
- Make stdin behavior explicit: for now, daemonized shell commands are non-interactive.

## Non-goals

- No PTY support in this round.
- No API for writing into daemon stdin.
- No cross-machine or cross-user daemon control protocol.
- No compatibility layer for the old daemon tracking model.

---

## Core Decisions

### 1. `1 daemon : 1 runner`

Every daemon-capable `shell_cmd` execution gets its own `cmd_runner` process. That runner is responsible for:

- spawning the actual shell/command process
- owning the stdout/stderr pipes
- maintaining scrollback buffers
- answering local IPC requests for status, output, and stop

The runner is not a shared global service. It lives and dies with the daemon it owns:

- if the daemon exits normally, the runner exits too
- if the daemon is stopped, the runner exits too
- a runner never manages multiple daemon commands

This is the key architectural shift. The component that owns the output buffers must not be the same process that is allowed to crash and restart independently.

### 2. Every `shell_cmd` starts under a runner from the beginning

The old model had an ownership split:

- Dominds main process spawns the command
- Dominds main process captures output
- if the timeout expires, the command is reclassified as a daemon

That split is the root of the recovery problem. The new model removes it entirely.

Every `shell_cmd` runs under a runner from the start:

- if the command finishes before the timeout, the runner returns the result and exits
- if the timeout expires, the runner stays alive, the command becomes a tracked daemon, and reminder metadata is written

There is no “upgrade” step where ownership changes mid-flight.

### 3. On Unix, the runner is the process-group leader

The runner should be the process-group leader, and the daemon command should inherit that pgid by default. That makes fallback cleanup straightforward.

The stop flow is intentionally two-layered:

- **Graceful stop path:** the runner sends a signal directly to the daemon pid
- **Fallback path:** if the daemon does not exit in time, the Dominds main process kills the whole process group
- **Escape is allowed:** if the daemon intentionally changes its pgid, that is treated as an escape hatch; fallback cleanup should still attempt a direct pid kill afterward

The direct signal to the daemon pid is the primary stop mechanism, not an afterthought.

---

## High-level Structure

There are three roles in the new model:

- **Dominds main process**
  - handles tool calls
  - persists reminders
  - reconnects to runners after restart
- **cmd_runner**
  - executes the shell command
  - owns stdout/stderr scrollback
  - serves a local IPC endpoint
- **daemon command**
  - the actual user-requested command
  - supervised by the runner

Ownership boundaries are simple:

- the runner is the source of truth for daemon output
- the Dominds main process is not a durable owner of daemon scrollback
- reminders store only the data needed to reconnect and validate identity

---

## Tool Contract Changes

## `get_daemon_output`

### Old contract

- `pid`
- optional `stream: "stdout" | "stderr"`

### New contract

- `pid: number`
- `stdout?: boolean`
- `stderr?: boolean`

### Semantics

- if both booleans are omitted, treat them as `stdout=true` and `stderr=true`
- if both are explicitly `false`, return an error
- output order is always `stdout` first, then `stderr`
- each stream gets its own heading, content block, and scroll notice
- unrequested streams are omitted entirely

### Why this is better

Daemon troubleshooting usually wants both streams together. Two booleans are also a better fit for “only stdout”, “only stderr”, or “both” than a single enum.

There is no compatibility shim for the old `stream` parameter.

## `stop_daemon`

The tool keeps the same role, but the control path changes:

1. Dominds connects to the runner
2. the runner sends a graceful stop signal directly to the daemon pid
3. Dominds waits for a short grace window
4. if needed, Dominds kills the whole process group as fallback
5. if needed, Dominds also kills the daemon pid directly
6. reminder state and local tracking are removed

The runner-driven direct pid signal is the first-class stop mechanism.

---

## IPC Model

### Transport

- Linux: prefer `${XDG_RUNTIME_DIR}`; fall back to a writable temp directory if needed; the endpoint name includes the daemon pid
- macOS: use a socket under `${TMPDIR}`; the exact path is persisted in reminder metadata, so `TMPDIR` drift across restarts does not matter
- Windows: use a named pipe with a stable daemon-oriented name

The main rule is simple:

- the exact endpoint path/name must be stored in reminder metadata
- recovery should reconnect to that exact endpoint instead of trying to reconstruct it heuristically

Using `/run/...` directly as a default is discouraged because many ordinary user processes cannot create sockets at the filesystem root under `/run`.

### Protocol style

v1 only needs a local request-response protocol. No subscriptions, no streaming channel, no long-lived session state.

The runner should support at least:

- `ping`
- `get_status`
- `get_output`
- `stop`

Responses should always include enough identity data for validation:

- `daemonPid`
- `runnerPid`
- `startTime`
- `daemonCommandLine`

The point is not just to prove “something is listening on that endpoint”. The point is to prove that the listener is still the runner for the original daemon instance.

### `get_output`

Its request shape should mirror the tool contract:

- `stdout: boolean`
- `stderr: boolean`

Its response should keep the streams separate:

- `stdout.content`
- `stdout.linesScrolledOut`
- `stderr.content`
- `stderr.linesScrolledOut`

Do not collapse both streams into one merged blob. The main process still needs stream-aware rendering and diagnostics.

---

## Reminder Metadata Contract

Daemon reminders should store at least:

- `kind: "daemon"`
- `daemonPid`
- `runnerPid`
- `runnerEndpoint`
- `initialCommandLine`
- `daemonCommandLine`
- `shell`
- `startTime`
- `processGroupId`
- `originDialogId`
- `completed?`
- `lastUpdated?`

Why each field matters:

- `daemonPid` is the tool-facing identity users care about
- `runnerEndpoint` is the primary reconnect target
- `runnerPid` and `processGroupId` help with stop and stale cleanup
- `daemonCommandLine + startTime` protect against pid reuse

This design intentionally does **not** add an `authToken`. If recovery must survive a main-process restart, any such token would also need to survive in recoverable state. Under that constraint, it adds complexity without much real local-security value. The meaningful protection boundary here is local reachability plus restrictive endpoint permissions.

---

## Stale Detection and Cleanup

When Dominds touches a daemon reminder, recovery should work like this:

1. read `runnerEndpoint` from reminder metadata
2. try to connect and issue `ping` or `get_status`
3. if the runner reports matching `daemonPid`, `daemonCommandLine`, and `startTime`, treat it as healthy
4. if the endpoint is unreachable, inspect the current OS process for `daemonPid`
5. if that process no longer exists, drop the reminder
6. if that process still exists and still matches the recorded command line and start time, treat it as a **stale daemon**
7. kill the stale daemon and drop the reminder
8. if the pid now belongs to an unrelated process, do not kill it; just invalidate the reminder

The key rule is:

- a daemon is only truly recoverable if its runner is still reachable

If the daemon process is still alive but the runner is gone, the scrollback owner is already gone too. That is a stale instance, not a healthy one.

---

## Scrollback Semantics

The runner owns two independent rolling buffers:

- `stdout`
- `stderr`

The retention policy can stay line-based:

- each stream tracks its own `linesScrolledOut`
- `get_daemon_output` reports the two streams separately
- daemon reminder snapshots render the two streams separately too

As long as the runner is alive, a restarted Dominds main process can reconnect and read the same scrollback state. That is the entire point of the redesign.

---

## stdin Policy

For this round, shell commands under the runner are explicitly **non-interactive**:

- `stdin` is always configured as `ignore`
- commands do not inherit the Dominds main-process terminal
- there is no stdin forwarding API
- the system does not pretend to support partial interactivity

This is cleaner than the old quasi-interactive setup:

- commands that expect stdin will see EOF immediately or fail according to their own logic
- commands do not hang forever waiting for invisible input
- the product contract becomes honest: interactive shells are not supported yet

If interactive command sessions are needed later, that should be a separate design with:

- a PTY-backed runtime
- explicit write-to-stdin APIs
- a clear split between ordinary shell commands and interactive terminal sessions

---

## Failure Semantics

The redesign must stay loud by default. It must not silently degrade into “no output”.

Examples:

- runner endpoint unreachable
- runner endpoint reachable but identity does not match the reminder
- daemon pid still alive but runner is gone
- `stdout=false` and `stderr=false`
- stop requested but the daemon refuses to die

Those cases should surface as explicit errors or explicit stale/unrecoverable states. In particular:

- “runner gone, daemon still alive” must not be rendered as an empty output buffer
- pid reuse must be detected explicitly so that Dominds never mistakes an unrelated process for the original daemon

---

## Replacement Scope

This redesign should replace the daemon path end-to-end:

- `shell_cmd` daemon execution becomes runner-owned
- `get_daemon_output` moves to the dual-boolean contract
- `stop_daemon` becomes runner-aware
- daemon reminders become runner-aware
- the main-process daemon scrollback owner logic is removed

The following are explicitly out of scope:

- a compatibility layer for the old `stream` parameter
- long-term compatibility for old daemon reminder metadata
- dual-write or dual-read between main-process buffers and runner buffers

Old daemon reminders from the previous implementation should be treated as non-recoverable legacy state and cleaned up on first contact instead of being kept alive through a half-compatible path.

---

## Summary

This redesign is not about making `get_daemon_output` slightly smarter. It is about moving daemon ownership to the only place where restart-safe scrollback can actually exist.

- **execution owner:** runner
- **scrollback owner:** runner
- **stop owner:** runner first, main process as fallback
- **recovery owner:** main process reconnecting through reminder metadata

Once those ownership boundaries are corrected, daemon log recovery after a Dominds main-process restart becomes a real capability instead of a best-effort illusion.
