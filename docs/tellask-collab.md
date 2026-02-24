# Tellask Collaboration Best Practices (Draft)

Chinese version: [中文版](./tellask-collab.zh.md)

> Status: Draft  
> Scope: this doc separates what is already implemented from what we should improve next.

## 1. Why this doc exists

Dominds already has a real Tellask runtime. The current pain is not syntax, but coordination behavior:

- The tellasker receives a checkpoint-style reply and assumes the tellaskee is still executing in the background.
- The tellasker narrates “what should happen next” instead of sending the next Tellask.

That mismatch stalls execution while sounding productive.

This document has three goals:

- Restate the implemented runtime contract in practical terms.
- Define an operator-friendly collaboration playbook.
- Propose a fast root fix, centered on priming + system prompt updates.

---

## 2. Current runtime contract (already implemented)

These points reflect current behavior in `dialog-system.md`, `fbr.md`, and `diligence-push.md`.
`agent-priming.md` now documents the startup-script priming design and maintenance workflow.

### 2.1 Three Tellask modes

- `TellaskBack`: `tellaskBack({ tellaskContent: "..." })`
- `Tellask Session`: `tellask({ targetAgentId: "<teammate>", sessionSlug: "<slug>", tellaskContent: "..." })`
- `Fresh Tellask`: `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`

### 2.2 What `Tellask Session` really means

- `sessionSlug` gives resumable addressing and reusable context.
- It does not create an always-running worker.
- Progress still happens one Tellask call at a time.

Short version: a Tellask Session is a resumable thread, not autonomous background execution.

### 2.3 Per-call lifecycle

For teammate Tellasks, the runtime lifecycle is:

1. Tellask is emitted.
2. Caller waits while sideline runs.
3. A response is supplied back.
4. Caller resumes.

Critical operational fact:

- The current teammate response status is effectively `completed` or `failed`.
- There is no “still running that same request” status after a response is delivered.

So if more work is needed, the tellasker must issue the next Tellask explicitly.

### 2.4 Diligence Push boundary

- Diligence Push helps the tellasker dialog avoid going idle.
- It does not send teammate Tellasks on the agent’s behalf.
- It is a pressure mechanism, not an execution orchestrator.

---

## 3. Primary failure mode and root cause

### 3.1 Primary issue: checkpoint reply is misread as ongoing execution

Observed behavior:

- Tellasker dialog receives “phase 1 done”.
- Tellasker dialog then says “waiting for them to continue”.
- No new Tellask is sent, so progress stops.

Root cause:

- The model confuses session continuity with execution continuity.
- It treats “same `tellaskSession`” as “still running” instead of “ready to be resumed by a new Tellask”.

### 3.2 Secondary issue: narrative delegation instead of action

Typical anti-pattern:

- “I don’t have shell permission; please ask @<shell_specialist> to run `pnpm lint:types` and send back the output.”

That is a workflow break. The model should send the Tellask directly.

---

## 4. Best-practice execution protocol

### 4.0 Delivery markers and sideline rule (mandatory)

**First-line markers (required)**:

- `【tellaskBack】` — required when asking the tellasker dialog for clarification / next-step confirmation.
- `【最终完成】` — required for final delivery after all assigned goals are complete.
- FBR-only: `【FBR-直接回复】` or `【FBR-仅推理】`.

**Sideline delivery rule**:

- A sideline dialog may reply directly to the tellasker dialog **only when all goals are complete**.
- If any goal is incomplete or critical context is missing, it MUST issue `tellaskBack({ tellaskContent: "..." })` before proceeding.
- **FBR exception**: FBR forbids all tellasks (including `tellaskBack` / `askHuman`); list missing context + reasoning and return.

Note: no extra "Status: ..." line is required; the first-line marker is the stage reminder.

### 4.1 Four-step teammate Tellask loop

For teammate Tellasks (non-`freshBootsReasoning({ tellaskContent: "..." })`), always run this loop:

1. `Initiate`: send a Tellask with scope, constraints, and acceptance evidence.
2. `Wait`: wait for that specific response.
3. `Judge`: classify response as done / not done / needs clarification.
4. `Continue`: if not done, send the next Tellask immediately (usually same session slug).

Hard rule:

- You can only claim “waiting for result” if there is an explicit pending Tellask and known acceptance evidence.

### 4.2 Always continue via explicit re-Tellask

Recommended pattern:

```text
tellask({
  targetAgentId: "shell_specialist",
  sessionSlug: "typecheck-loop",
  tellaskContent: [
    "Run `pnpm lint:types` and return raw output only.",
    "If it fails, include the first 3 errors with file + line.",
    "Acceptance: include exit code and the first actionable anchor.",
  ].join("\n"),
})
```

Do not do this:

```text
I will now wait for @shell_specialist to keep going.
```

### 4.3 Replace narrative delegation with direct Tellask

Bad:

```text
I cannot run shell here; please ask @shell_specialist to execute `pnpm lint:types`.
```

Good:

```text
tellask({
  targetAgentId: "shell_specialist",
  sessionSlug: "typecheck-loop",
  tellaskContent: [
    "Please execute `pnpm lint:types` now and paste raw output.",
    "If command is unavailable, paste the error and one safe alternative.",
  ].join("\n"),
})
```

---

## 5. Fast root fix: priming + prompt

A reminder-only approach will keep regressing. Use two layers:

- Prompt constraints for immediate behavior correction.
- Collaboration priming for durable muscle memory.

### 5.1 Prompt updates (P0)

Add or strengthen these coordination constraints:

1. `Response-closes-call`: teammate response closes the current call; continuation requires a new Tellask.
2. `Wait-state guard`: only claim waiting when a concrete pending Tellask exists.
3. `Autonomy guard`: do not use askHuman() as a relay for executable teammate work.
4. `Action-over-narration`: if you write “next ask @X to do Y”, emit `tellaskSessionless({ targetAgentId: "X", tellaskContent: "..." })` in the same turn.

### 5.2 Collaboration priming (P1)

Split the collaboration drill into two short segments, both grounded in verifiable facts:

1. One-shot Tellask: `uname -a` as the runtime baseline.
2. Long-session Tellask: `tellaskSession: rtws-vcs-inventory` for a two-round repo inventory.
3. Run `freshBootsReasoning({ tellaskContent: "..." })` FBR and distillation only after both evidence segments are available.

Operating rules:

1. If no `shell_specialist` is available, Dominds runtime gathers the same facts (`uname -a` + git inventory). This is a standard mode, not a degraded path.
2. A response closes the current round; continuation requires a new explicit Tellask.
3. “Ask teammate to do X” must materialize as `tellask* function call`, not as a relay request to askHuman().

### 5.3 P1 design baseline (implemented)

#### Design goals

1. Keep it short: only `uname` plus two VCS rounds are added to existing priming.
2. Keep it general: works in any rtws, with or without a shell specialist.
3. Keep it stable: runtime templates script key steps to reduce model drift.
4. Keep semantics sharp: behavior must reflect “response closes round; continuation requires re-Tellask”.

#### Unified sequence

1. `Prelude Intro`: declare shell policy (`specialist_only` / `self_is_specialist` / `no_specialist`).
2. `uname` baseline:
   - `specialist_only`: tellasker dialog sends one-shot Tellask to `@<shell_specialist>` and receives response.
   - other policies: runtime collects and displays `uname -a`.
3. `VCS Round-1` (same `tellaskSession`): topology inventory
   - whether rtws root is a git repo
   - submodule list
   - nested independent repo list
4. `VCS Round-2` (continuation in same `tellaskSession`): per-repo status
   - remotes (fetch/push)
   - branch / upstream
   - dirty state
5. Merge `uname + VCS` into one evidence block for `freshBootsReasoning({ tellaskContent: "..." })` FBR.
6. Distill after FBR feedback is complete, and produce the priming note.

#### Tellask template constraints

1. Round-1/2 Tellask bodies are runtime-generated.
2. Round-2 body must explicitly state Round-1 is closed and this is a new continuation Tellask.
3. Each round has a single objective; no repair plan or scope expansion in the round body.

#### No-shell-specialist mode (standard support)

1. Runtime emits `uname` and both VCS round notes directly.
2. FBR receives the same structured evidence shape as the specialist path.
3. Priming note requirements stay identical: close-on-response and explicit re-Tellask for continuation.

#### Data shape (legacy priming plan)

1. `shell` is a discriminated union:
   - `specialist_tellask` (tellask body, response, `uname` snapshot)
   - `direct_shell` (runtime note, `uname` snapshot)
2. `vcs` is a discriminated union:
   - `specialist_session` (Round-1/2 tellask+response, `inventoryText`)
   - `runtime_inventory` (Round-1/2 runtime notes, `inventoryText`)
3. `buildCoursePrefixMsgs` injects in fixed order: shell snapshot -> VCS inventory -> FBR summary -> priming note.

#### P1 acceptance criteria

1. Priming transcript shows `uname` baseline plus two VCS rounds (Round-2 after Round-1 response).
2. No-shell-specialist path still shows two runtime VCS rounds and uses them for the same FBR step.
3. Priming note explicitly states “response closes round; continuation requires re-Tellask”.
4. Replay preserves the path-specific pattern (`specialist_session` or `runtime_inventory`).
5. `pnpm -C dominds run lint:types` passes without breaking existing priming/FBR/diligence behavior.

---

## 6. Tellasker dialog operator checklist

Before and after each collaboration step:

1. Did I send a concrete Tellask with acceptance evidence?
2. If I say “waiting”, which pending Tellask am I waiting on?
3. After receiving feedback, did I either close the task or send the next Tellask?
4. Did I turn “ask teammate to do X” into an actual `tellask* function call` block?
5. Did I write key decisions back to Taskdoc (root dialog only) instead of leaving them in chat only?

---

## 7. Recommended rollout

1. `P0`: ship prompt-level coordination constraints.
2. `P1`: add tellask-collab priming drill.
3. `P2`: add regressions that fail when:
   - checkpoint replies do not trigger explicit continuation Tellask;
   - the model asks humans to relay executable teammate actions.

With this sequence, Diligence Push remains supportive rather than compensatory.
