# Dominds Roadmap

Chinese version: [中文版](./roadmap.zh.md)

## Summary

This document outlines Dominds’ stage goals and major-version evolution to align priorities and architectural decisions. It is not a delivery promise; details will evolve based on validation.

Dominds’ long-term direction is to solidify “agent social division of labor” into a reusable, extensible, installable/uninstallable runtime system: **microkernel + Apps**.

Terminology (Mainline/Sideline, etc.): [`dominds-terminology.md`](./dominds-terminology.md)

---

## North Star

Become a **microkernel for agent social division of labor and collaboration**:

- **The microkernel only does scheduling**: dialog/task orchestration, events and streaming transcripts, capability boundaries and permissions, persistence and observability, plus App lifecycle and registration.
- **Capabilities are installed on demand**: toolsets, interaction controls, UI, workflows/DSLs are delivered as **Dominds Apps**; and Apps are managed independently **per rtws (runtime workspace)**—each rtws can install/uninstall and enable/disable Apps as needed.
- **Multiple frontends can coexist**: the same rtws can host multiple frontend Apps (e.g. WebUI/TUI/specialized visualizations: business data dashboards, process/workflow visualization, operations UIs (front/middle/back office), interactive game UIs) that integrate via a consistent protocol.

---

## 0.x: Proof of Concept (PoC) + Preview Releases

Positioning: validate “stable and effective ways of working”, and make the core mechanisms work end-to-end, reliably, and debuggably.

- Establish reusable work patterns: mainline progress + parallel sideline dialogs + result backflow/aggregation (Tellask / FBR, etc.).
- Harden a minimal runtime loop: dialog persistence, tool invocation, streaming output + transcripts, basic observability and failure diagnosis.
- Iterate in small steps: allow internal structure to change rapidly while continuously distilling what is stable/effective into explicit constraints.

---

## 1.x: Microkernel Architecture Migration (Kernel ↔ Dominds Apps)

Positioning: clearly separate “kernel” vs “Dominds Apps”, forming an extensible capability system that can be installed on demand.

### 1) Kernel–App boundary

- Kernel: only the necessary, universal runtime pieces (scheduling, protocol, persistence, etc.).
- Apps: optional/replaceable/diverse capabilities (toolsets, interaction control components, UI, workflows, etc.).

### 2) Apps installed per rtws

- Apps are installed/uninstalled per rtws, and can be enabled/disabled at runtime.
- Apps can **dynamically register**:
  - toolsets
  - run-control components (e.g. phase gates, approvals, human–agent pacing controls, budget/limiters)
  - event subscriptions and visualization panels (e.g. streaming substreams, teammate collaboration status)

### 3) WebUI as an App (plural frontends)

- Treat WebUI as a replaceable/coexisting App, not a “built-in UI” of the kernel.
- Enable diverse frontend Apps:
  - different interaction modes (chat/board/graph/timeline/replay)
  - different roles (developer/operator/auditor/observer)

### 4) Phaser App: turning workflows into an operable “system”

- Develop a **Phaser App** as an interactive frontend/visual runtime console for stronger operability and pacing control.
- Build a DSL on top of **Mermaid** (graph-as-code):
  - model workflows as state machines (states / transitions / guards)
  - use **Phase-Gates** to make phase transitions controlled: key jumps require explicit conditions, evidence, and (optional) human confirmation
  - make “mechanizable parts” explicit: let agents handle uncertainty, and let the system provide controllability

---

## 2.x: Dominds as a True Microkernel (Only Scheduling)

Positioning: Dominds only schedules and orchestrates; everything else becomes an installable/uninstallable App.

- Toolsets, interaction control, and UI fully migrate into independent Apps (the kernel no longer ships default implementations).
- Stronger App ecosystem capabilities:
  - App manifests/dependencies/versions and compatibility constraints
  - capability boundaries and permission policies (least privilege, auditable)
  - standardized observability (events, metrics, replay)

---

## Cross-Version Principles

- **rtws-first**: scope capabilities/state by rtws for project/team isolation and reuse.
- **protocol-first**: align kernel↔Apps and frontend↔backend via stable protocols; avoid “must upgrade together” coupling.
- **debuggability as a first-class feature**: every streaming/concurrent/collaboration mechanism must be replayable, diagnosable, and explainable.
