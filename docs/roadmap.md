# Dominds Roadmap

Chinese version: [中文版](./roadmap.zh.md)

## Summary

This document outlines Dominds’ stage goals and evolution direction to align priorities and architectural decisions. It is not a delivery promise; details will evolve based on validation.

Dominds’ long-term direction is to solidify “agent social division of labor” into a reusable, extensible, composable runtime system: **Kernel + application components + App composition root**.

Terminology (Main Dialog/Side Dialog, etc.): [`dominds-terminology.md`](./dominds-terminology.md)

---

## North Star

Become a **microkernel for agent social division of labor and collaboration**:

- **The microkernel owns only generic runtime mechanisms**: dialog driving, events and streaming transcripts, capability boundaries and permissions, persistence and observability, plus loading and isolating an App composition.
- **Capabilities are composed on demand**: stable, versioned application components provide toolsets, collaboration mechanisms, UI, workflows/DSLs, and other capabilities; an **App is an evolvable composition root** that may explicitly add, remove, or replace components as business needs change and runs per rtws (runtime workspace).
- **Multiple frontend components can coexist**: one App may select WebUI, TUI, or specialized visualization components for its business and connect them to the same runtime instance through consistent protocols.

---

## Stage 0: Proof of Concept (PoC) + Preview Releases

Positioning: validate “stable and effective ways of working”, and make the core mechanisms work end-to-end, reliably, and debuggably.

- Establish reusable work patterns: Main Dialog progress + parallel Side Dialogs + result backflow/aggregation (Tellask / FBR, etc.).
- Harden a minimal runtime loop: dialog persistence, tool invocation, streaming output + transcripts, basic observability and failure diagnosis.
- Identify mature capabilities that are still coupled into built-in implementation: keep dialog driving in the Kernel; form a tellask component from tellask and team definition; form a workenv component from the work environment and control toolset; temporarily keep WebUI built in while Dominds evolves.
- Iterate in small steps: allow internal structure to change rapidly while continuously distilling what is stable/effective into explicit constraints.

---

## Stage 1: Kernel–Component–App Architecture Migration

Positioning: clearly separate the Kernel, reusable application components, and the App composition root, forming an extensible capability system that can be assembled on demand.

### 1) Kernel–application boundary

- Kernel: only generic dialog driving, protocols, persistence, isolation, and non-bypassable execution boundaries.
- Application components: reusable and replaceable business capabilities such as toolsets, collaboration mechanisms, UI, and workflows.
- App: the composition root that explicitly selects, configures, and binds components without promoting component dependencies into globally enabled peer Apps.

### 2) Establish the application component model

- An application component is an App-side reuse and building unit, not a mini-App with independent runtime authority.
- An application component has a relatively static lifecycle: its artifact is installed and upgraded by version, and its definition is not repeatedly enabled, disabled, or rewritten as business context changes.
- Component contracts explicitly declare lifecycle, configuration, state namespace, `requires/provides`, toolsets, business handlers, and UI contributions.
- Toolsets have one unified meaning: provided by a component, selected by an App, and bound to an execution principal. They are not split into separate “dynamic” and “static” wiring models.
- Runtime context may affect whether a concrete capability is admitted, but it must not silently alter the current App composition revision or implicitly enable components globally.

### 3) App composition and rtws management

- The App is the sole composition root and business runtime identity. Its lifecycle is more dynamic: it may add, remove, or replace components frequently as business needs change.
- Every recomposition creates a new composition revision. Within one revision, component selection, configuration, requirement bindings, and policy versions are atomically determined; a new revision activates only after resolution, migration, and validation all succeed.
- Replacing components must explicitly handle draining in-flight actions, migrating or retiring component state, and rollback on failure. One action must never switch implementation across revisions.
- Switching the composition revision is itself a Kernel-controlled action. Until the switch completes, the current revision's authoritative policies remain in force and cannot be bypassed by removing their component first.
- An App dependency denotes a required building unit or external capability; it does not automatically promote another complete App into a globally enabled peer App.

### 4) Migrate WebUI from a built-in feature to an optional application component

- Keep shipping WebUI as a built-in Dominds feature early only to reduce iteration and debugging cost; that convenience does not define the final boundary.
- Once the Kernel can run headless and component lifecycle, frontend mounting and routing, public frontend/backend protocols, state namespaces, and App composition loading are stable, move WebUI out of the built-in feature set and make it an App-selectable component.
- Enable diverse frontend components:
  - different interaction modes (chat/board/graph/timeline/replay)
  - different roles (developer/operator/auditor/observer)

---

## Stage 2: A True Microkernel and Application Ecosystem

Positioning: the Kernel can run headless; application components provide every optional business capability, and Apps compose them into concrete installable and runnable applications.

- Optional toolsets, business control, and UI are provided by application components and composed by Apps; the Kernel no longer ships default business implementations.
- Complete component and App ecosystem capabilities:
  - component manifests, App composition manifests, dependencies, versions, and compatibility constraints
  - stable component release lifecycles plus dynamic App composition revision, isolation, migration, and rollback
  - capability boundaries and permission policies (least privilege, auditable)
  - standardized observability (events, metrics, replay)

---

## Cross-Stage Principles

- **rtws-first**: scope capabilities/state by rtws for project/team isolation and reuse.
- **explicit, revision-atomic composition**: a component never becomes active merely because it is installed or discovered; only explicit selection and binding by an App puts it into a new composition revision, and every in-flight action remains attributable to one exact revision.
- **protocol-first**: align the Kernel, application components, App composition, and frontend/backend components through stable protocols; avoid “must upgrade together” coupling.
- **debuggability as a first-class feature**: every streaming/concurrent/collaboration mechanism must be replayable, diagnosable, and explainable.
- **fail closed at integrity boundaries**: missing components, composition conflicts, state revision conflicts, or indeterminate controlled actions must fail loudly; only presentation failures that cannot affect business integrity or accountability may preserve liveness and self-heal later.
- **Direct expression, fewer abstractions**: without weakening integrity boundaries, state business intent more directly, with fewer extra abstractions, fewer newly invented labels, and less technical phrasing that hides the business meaning. Specific “this should not be too wordy” judgments belong in the concrete business scenario, not as a low-level instruction to chase the shortest path or the quietest log.
