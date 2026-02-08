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

These points reflect current behavior in `dialog-system.md`, `fbr.md`, `dominds-agent-priming.md`, and `diligence-push.md`.

### 2.1 Three Tellask modes

- `TellaskBack`: `!?@tellasker`
- `Tellask Session`: `!?@<teammate> !tellaskSession <slug>`
- `Fresh Tellask`: `!?@<teammate>`

### 2.2 What `Tellask Session` really means

- `!tellaskSession <slug>` gives resumable addressing and reusable context.
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

- Diligence Push helps mainline avoid going idle.
- It does not send teammate Tellasks on the agent’s behalf.
- It is a pressure mechanism, not an execution orchestrator.

---

## 3. Primary failure mode and root cause

### 3.1 Primary issue: checkpoint reply is misread as ongoing execution

Observed behavior:

- Mainline receives “phase 1 done”.
- Mainline then says “waiting for them to continue”.
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

### 4.1 Four-step teammate Tellask loop

For teammate Tellasks (non-`!?@self`), always run this loop:

1. `Initiate`: send a Tellask with scope, constraints, and acceptance evidence.
2. `Wait`: wait for that specific response.
3. `Judge`: classify response as done / not done / needs clarification.
4. `Continue`: if not done, send the next Tellask immediately (usually same session slug).

Hard rule:

- You can only claim “waiting for result” if there is an explicit pending Tellask and known acceptance evidence.

### 4.2 Always continue via explicit re-Tellask

Recommended pattern:

```text
!?@shell_specialist !tellaskSession typecheck-loop
!?Run `pnpm lint:types` and return raw output only.
!?If it fails, include the first 3 errors with file + line.
!?Acceptance: include exit code and the first actionable anchor.
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
!?@shell_specialist !tellaskSession typecheck-loop
!?Please execute `pnpm lint:types` now and paste raw output.
!?If command is unavailable, paste the error and one safe alternative.
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
3. `Autonomy guard`: do not use @human as a relay for executable teammate work.
4. `Action-over-narration`: if you write “next ask @X to do Y”, emit `!?@X ...` in the same turn.

### 5.2 Collaboration priming (P1)

Run a short, real collaboration drill so the model feels the rhythm:

1. Mainline sends a real Tellask to `@shell_specialist`.
2. After first response, mainline must send a second Tellask to continue.
3. Mainline writes a tiny priming note capturing:
   - response closes this round
   - continuation requires re-Tellask
   - delegation statements must become real Tellasks immediately

This creates behavior memory more reliably than longer prose in system prompts.

---

## 6. Mainline operator checklist

Before and after each collaboration step:

1. Did I send a concrete Tellask with acceptance evidence?
2. If I say “waiting”, which pending Tellask am I waiting on?
3. After receiving feedback, did I either close the task or send the next Tellask?
4. Did I turn “ask teammate to do X” into an actual `!?@...` block?
5. Did I write key decisions back to Taskdoc instead of leaving them in chat only?

---

## 7. Recommended rollout

1. `P0`: ship prompt-level coordination constraints.
2. `P1`: add tellask-collab priming drill.
3. `P2`: add regressions that fail when:
   - checkpoint replies do not trigger explicit continuation Tellask;
   - the model asks humans to relay executable teammate actions.

With this sequence, Diligence Push remains supportive rather than compensatory.
