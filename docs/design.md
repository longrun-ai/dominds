# Dominds: Social Division of Labor for AI Agents

## Overview

Dominds implements **Social Division of Labor** for AI agents - a systematic approach to managing cognitive overload through strategic mental clarity practices. This document outlines our comprehensive framework for preventing agentic disorientation and maintaining productive focus in AI-human collaborative environments.

**Core Problem**: LLM agents get disoriented easily, far before technical context windows get fully filled. The problem is never too many tokens, but too many aspects and concerns - they suffer from mental overloading, just like humans.

**Key Design Principle**: Agents operate in **autonomous "YOLO mode"** with **Fresh Boots Reasoning** - making independent decisions with clean mental states through strategic context reset and task-centered focus architecture.

## Table of Contents

1. [The Problem: Agentic Disorientation](#the-problem-agentic-disorientation)
2. [Social Division of Labor Solution](#social-division-of-labor-solution)
3. [Fresh Boots Reasoning Framework](#fresh-boots-reasoning-framework)
4. [Architectural Patterns](#architectural-patterns)
5. [Implementation Details](#implementation-details)
6. [Best Practices](#best-practices)
7. [Future Directions](#future-directions)

---

## The Problem: Agentic Disorientation

### Core Issue: Cognitive Overload in AI Agents

> LLM agents get disoriented easily, far before technical context windows get fully filled

This fundamental problem manifests in several ways:

**1. Context Fragmentation**

- Agents struggle to maintain coherent reasoning threads across extended interactions
- Important context gets buried under accumulated conversation history
- Decision-making quality degrades as conversation length increases

**2. Attention Dilution**

- Agents spread their cognitive resources across too many competing priorities
- Relevant information gets lost in the noise of past interactions
- Focus shifts from primary objectives to tangential details

**3. Mental State Degradation**

- Agent's "mental model" becomes cluttered and inconsistent
- Previous assumptions persist even when context has changed
- Reasoning paths become increasingly convoluted

### Why Traditional Solutions Fall Short

> the problem is never too much tokens, but too many aspects / concerns, they suffer from mental overloading, just like humans

**Token Capacity vs. Cognitive Capacity**

- Human-like working memory limitations apply to AI agents despite large token limits
- Quality of reasoning decreases long before hitting token limits
- Context window isn't the bottleneck—cognitive bandwidth is

**Multi-faceted Attention Spread**

- Each conversation turn adds new constraints, goals, and considerations
- Agents must maintain awareness of project scope, user preferences, technical constraints, etc.
- Cognitive load compounds exponentially with interaction complexity

### Sources of Mental Overhead

1. **Conversational Noise**
   - Repeated tool failures and error messages
   - Debugging attempts and diagnostic output
   - Tangential discussions that drift from core objectives
   - Redundant information and circular conversations

2. **Context Pollution**
   - Accumulated dialog history that obscures current priorities
   - Outdated information that conflicts with current state
   - Mixed signal-to-noise ratio in conversation threads

3. **Attention Drift**
   - Loss of focus on primary task objectives
   - Reactive rather than strategic thinking patterns
   - Fragmented mental models across dialog participants

---

## Social Division of Labor Solution

### Context Compaction: Limited Effectiveness

> context compaction? that's a rather poor mitigation for agentic disorientation

**What Context Compaction Actually Does**

- Summarizes long conversation histories into condensed forms
- Preserves key facts while reducing token count
- Maintains a "cliff notes" version of past interactions

**Limitations of Compaction Approaches**

**1. Information Loss**

- Critical nuanced context gets lost in summarization
- Important decision-making rationale disappears
- Distinctions between similar-but-different scenarios blur

**2. Temporal Context Issues**

- Compaction loses the sequence of reasoning
- Cause-effect relationships become muddied
- Understanding of why certain decisions were made deteriorates

**3. Static vs. Dynamic Context**

- Summarization creates rigid, outdated snapshots
- Context that should evolve becomes fossilized
- Agent loses awareness of current dynamic state

**4. Compounding Compression Loss**

- Each compaction pass loses more information
- Accuracy degrades with each compression cycle
- Eventually becomes counterproductive

### Proactive Context Management: The Better Approach

> change mind often, clear noises out of your mind often

**Core Philosophy: Mental Hygiene for AI Agents**

**1. Intentional Context Reset**

- Regular "cognitive cleanup" sessions
- Removing stale or irrelevant information
- Maintaining mental clarity through active pruning

**2. Task-Centered Focus Architecture**

- **Central Taskdoc**: Single source of truth for goals, constraints, and progress
- **Dynamic Context Windows**: Time-limited context retention
- **Priority-Based Information Filtering**: Automatic ranking of context relevance

### Taskdoc Structure

```
Taskdoc Structure:
├── Goals
│   ├── Clear goal statement
│   ├── Success criteria
│   └── Timeline constraints
├── Progress
│   ├── Active decisions pending
│   ├── Recently completed items
│   └── Immediate next steps
└── Constraints
    ├── Technical limitations
    ├── User preferences
    └── Resource boundaries
```

### Benefits of Task-Centered Architecture

**1. Reduced Cognitive Load**

- Agent focuses on one central document
- Eliminates need to parse through conversation history
- Clear separation between current task and historical context

**2. Improved Decision Quality**

- Consistent reference point for all decisions
- Reduced influence of outdated context
- Better alignment with user intent

**3. Enhanced Adaptability**

- Easy to pivot between different aspects of the task
- Quick context switching without information loss
- Maintains thread of continuity across sessions

### Strategic Implementation Patterns

**Pattern 1: Technical Analysis Mode**

```
Trigger: Complex technical decision needed
Fresh Session:
- Load task_doc + technical requirements
- Focus: "Analyze feasibility and recommend approach"
- Output: Clear technical recommendation with reasoning
```

**Pattern 2: Creative Ideation Mode**

```
Trigger: Need for new ideas or solutions
Fresh Session:
- Load task_doc + problem statement only
- Focus: "Generate innovative approaches without constraint bias"
- Output: List of creative solutions with rationale
```

**Pattern 3: Quality Assurance Mode**

```
Trigger: Need to validate current approach
Fresh Session:
- Load task_doc + current solution attempt
- Focus: "Identify weaknesses and improvement opportunities"
- Output: Critical analysis and recommendations
```

## Fresh Boots Reasoning Framework

### The Fresh Boots Concept

> ask yourself to meditate out of inference, then come back to the problem with ideas

**Core Principle**: Put a "fresh copy" of yourself into the same boots (task context) with a clean mental slate, specifically focused on one aspect of the problem.

**Traditional vs. Fresh Boots Approach**

**Traditional Problem-Solving:**

```
Agent: [Existing conversation history, current state, Taskdoc] + Problem
→ Attempts to solve all aspects simultaneously
→ Suffers from cognitive overload
→ Produces suboptimal results
```

**Fresh Boots Reasoning:**

```
Agent: [Clean mental state + Taskdoc only] + Specific sub-problem
→ Focuses on single aspect
→ Applies fresh reasoning without baggage
→ Produces clear, targeted solution
→ Returns insights to main agent
```

### Fresh Boots Mechanics

**1. Sub-Problem Isolation**

- Break complex problems into specific, bounded sub-questions
- Create detailed prompts for fresh reasoning sessions
- Ensure sub-questions are truly independent

**2. Fresh Context Creation**

- Reset agent's "mental state" to initial task understanding
- Load only the essential Taskdoc and sub-problem
- Clear away all accumulated conversation context

**3. Focused Reasoning Session**

- Agent attacks sub-problem with full cognitive bandwidth
- No distractions from other task aspects
- Pure problem-solving without context pollution

**4. Result Integration**

- Extract key insights from fresh reasoning
- Integrate findings back into main task context
- Maintain clean separation between insight and context

### Advanced Fresh Boots Strategies

#### The Multi-Lens Approach

**Concept**: Use different "lenses" or perspectives to examine the same problem, each with a fresh agent instance.

**Implementation:**

1. **Analytical Lens**: Pure logic and data-driven analysis
2. **Creative Lens**: Innovation and out-of-the-box thinking
3. **Critical Lens**: Skeptical evaluation and assumption testing
4. **User-Centric Lens**: Focus on end-user experience and value

#### The Progressive Refinement Cycle

**Phase 1: Initial Fresh Boots**

- Use clean reasoning to generate first-pass solution
- Capture raw insights without consideration of constraints

**Phase 2: Constraint Application**

- Second fresh session applies real-world constraints
- Integrates task requirements with initial insights

**Phase 3: Quality Validation**

- Third fresh session evaluates complete solution
- Identifies potential issues and improvement opportunities

#### Session Hierarchy: Meta-Fresh Reasoning

**Concept**: Sometimes even fresh boots reasoning needs refreshing.

**Levels of Freshness:**

1. **Level 0**: Current agent state
2. **Level 1**: Clean agent + task_doc (standard fresh boots)
3. **Level 2**: Completely reset agent with only problem statement
4. **Level 3**: New agent instance with different training focus

### Fresh Boots Implementation in Dominds

**Autonomous Triggers:**

- Agents detect when cognitive overload is affecting performance
- Self-initiated fresh reasoning sessions for complex sub-problems
- Automatic session management and result integration

**Task-Centered Fresh Sessions:**

- All fresh reasoning sessions reference the same central Taskdoc
- Ensures consistency across multiple focused reasoning attempts
- Maintains thread of continuity while allowing cognitive reset

**Multi-Agent Fresh Coordination:**

- Different agents can run fresh sessions on the same problem from different angles
- Parallel fresh reasoning accelerates complex problem solving
- Results automatically integrated into shared task context

---

## Architectural Patterns

### Dialog Hierarchy

```

Main Dialog (Root Dialog)
├── Taskdoc Reference → tasks/feature-auth.tsk/ (Workspace Taskdoc package)
├── Reminders (Working Memory)
├── Dialog Messages (Ephemeral)
└── Subdialogs (Tree-Structured, Stored Flat Under Main Dialog)
├── Specialized Agent A
│ ├── Taskdoc Reference → tasks/feature-auth.tsk/ (Same Taskdoc package)
│ ├── Parent Call Context
│ ├── Local Reminders
│ └── Local Dialog Messages
│ └── Sub-Subdialogs (Further Nesting Possible)
└── Specialized Agent B
├── Taskdoc Reference → tasks/feature-auth.tsk/ (Same Taskdoc package)
├── Parent Call Context
├── Local Reminders
└── Local Dialog Messages

```

**Key Properties**:

- All dialogs reference the same workspace Taskdoc (a `*.tsk/` Taskdoc package, e.g. `tasks/feature-auth.tsk/`)
- Multiple dialog trees can reference the same Taskdoc for collaborative work
- Taskdocs persist beyond individual conversations and survive team changes
- Subdialogs can be tree-structured with unlimited nesting depth
- All subdialog state is stored flat under the main dialog's (root dialog's) `subdialogs/` directory
- Each subdialog maintains its own working memory while referencing the same Taskdoc

### Memory Layers

#### Dialog-Scoped Memory (Per Conversation)

1. **Taskdoc Reference**: Points to a workspace Taskdoc tracking a specific DevOps assignment
   - `*.tsk/` Taskdoc packages (`goals.md`, `constraints.md`, `progress.md`)
   - Multiple dialogs can reference the same Taskdoc for collaborative work
   - Taskdocs persist throughout the entire product lifecycle, spanning multiple conversations and team changes
   - Can link to other product documentation and evolve as project requirements change
2. **Reminders**: Semi-persistent, dialog-scoped, survives conversation cleanup
3. **Parent Call Context**: Inherited context for subdialogs
4. **Dialog Messages**: Ephemeral, subject to cleanup for mental clarity

#### Workspace-Persistent Memory (DevOps Lifecycle)

5. **Team-Shared Memories**: Persistent across the entire project lifecycle
   - **Mission Context**: Shared understanding of project goals and constraints
   - **Collective Knowledge**: Accumulated insights, patterns, and lessons learned by the team
   - **Shared Standards**: Coding conventions, architectural decisions, and best practices
   - **Project History**: Important decisions, milestones, and contextual evolution

6. **Agent-Individual Memories**: Personal knowledge that persists per agent across all dialogs
   - **Personal Expertise**: Specialized knowledge and skills of individual agents
   - **Individual Lessons**: Personal learning and adaptation patterns
   - **Role-Specific Context**: Agent-specific responsibilities and operational knowledge
   - **Performance Patterns**: Individual optimization strategies and preferences

**Memory Characteristics**:

- **Transparency**: All memories are transparent to humans and adjustable by human oversight
- **Autonomous Evolution**: Memories are continuously improved by the agent team autonomously over time
- **Lifecycle Persistence**: Team and agent memories persist throughout the entire DevOps lifecycle
- **Human Accessibility**: Humans can inspect, modify, and guide memory evolution at any time

### Information Flow

- **Upward**: Subdialogs communicate results and escalations to parents
- **Downward**: Parents provide context and objectives to subdialogs
- **Lateral**: Coordination through shared Taskdocs and parent mediation
- **Temporal**: Reminders and Taskdocs provide continuity across time

---

## Implementation

For detailed implementation specifications, including core tools, technical architecture, and system behavior, see the [Dialog System Implementation](dialog-system.md) document.

**Key Implementation Components**:

- **`clear_mind`**: Function tool for clearing conversational noise and starting a new course
- **`change_mind`**: Function tool for updating authoritative Taskdocs across dialog hierarchies (no course reset)
- **Reminder Management**: Dialog-scoped working memory that persists across clarity operations
- **Hierarchical Dialog Architecture**: Tree-structured dialogs with flat storage and autonomous management
- **Memory Layers**: Dialog-scoped and workspace-persistent memory with autonomous evolution

The implementation emphasizes autonomous agent operation, enabling agents to independently manage their cognitive state, create and manage subdialogs, and coordinate with minimal human oversight.

---

## Best Practices and Guidelines

### When to Use Fresh Boots Reasoning

**Optimal Scenarios:**

- Complex multi-faceted problems
- Decision points requiring fresh perspective
- Creative ideation needs
- Quality assurance and validation
- Breaking through analysis paralysis

**When to Avoid:**

- Simple, straightforward tasks
- Situations requiring continuity with previous work
- Real-time interactive tasks
- Emergency response scenarios

### Session Design Principles

**1. Specificity**

- Define exact sub-problem scope
- Clear success criteria for each session
- Avoid vague or open-ended prompts

**2. Completeness**

- Ensure all necessary context is provided
- Include relevant constraints and requirements
- Provide any prerequisite knowledge needed

**3. Independence**

- Design sub-problems to be self-contained
- Minimize dependencies between sessions
- Allow for parallel processing when possible

### Measuring Effectiveness

**Key Metrics:**

1. **Solution Quality**: Does fresh reasoning produce better results?
2. **Speed**: How quickly can insights be generated?
3. **Consistency**: Are results reproducible across sessions?
4. **Efficiency**: Resource utilization compared to traditional approaches

**Success Indicators:**

- Clear, actionable insights emerge from each session
- Better alignment with user requirements
- Reduced time to problem resolution
- Higher quality of final solutions

### For AI Agents Operating in Autonomous Mode

#### Proactive Clarity Management

1. **Self-Directed Clarity Assessment**: Regularly evaluate your own cognitive load and conversation noise levels without waiting for external prompts

2. **Taskdoc Focus**: Always reference the Taskdoc as your primary source of truth when making autonomous decisions or changing direction

3. **Strategic Clarity Timing**: Trigger `clear_mind` when you detect that conversation noise is impacting your autonomous decision-making quality

4. **Independent Context Preservation**: Before any clarity operation, autonomously assess and preserve essential context through structured reminders

#### Fresh Boots Implementation

- **Self-Monitoring**: Continuously assess your own cognitive state and conversation quality without external prompts
- **Early Autonomous Intervention**: Independently trigger fresh reasoning sessions when you detect attention fragmentation, don't wait for overwhelming accumulation
- **Pattern Recognition**: Learn to autonomously identify signals of cognitive overload (repeated failures, circular discussions, loss of focus)
- **Strategic Autonomous Timing**: Use natural breakpoints in work for self-directed fresh reasoning operations

### For System Designers

#### Architecture Principles

1. **Autonomous-First Architecture**: Design systems that enable and encourage autonomous agent behavior rather than requiring constant human oversight

2. **Self-Management Tools**: Provide agents with tools and patterns that support autonomous cognitive state management and decision-making

3. **Clear Autonomous Boundaries**: Establish clear operational boundaries that allow agents to operate independently while maintaining system coherence

4. **Autonomous Feedback Loops**: Design systems where agents can autonomously assess their own performance and adjust behavior accordingly

5. **Independent Coordination Patterns**: Create coordination mechanisms that work without central control, enabling autonomous multi-agent collaboration

---

## Taskdoc Examples

### Example Taskdoc Structure

A Taskdoc is an encapsulated `*.tsk/` Taskdoc package that tracks a specific DevOps assignment:

```

tasks/auth-system.tsk/
├── goals.md
├── constraints.md
└── progress.md

```

Example contents:

- `goals.md`: “Implement secure user authentication with JWT tokens and role-based access control.”
- `constraints.md`: “MUST support email/password auth; MUST implement JWT refresh; MUST add role-based permissions…”
- `progress.md`: checklist/status notes (fast-changing).

### Taskdoc Lifecycle

**Creation Phase**:

```bash
# Create new Taskdoc
mkdir -p tasks
mkdir -p tasks/auth-system.tsk
echo "# Feature: User Authentication" > tasks/auth-system.tsk/goals.md

# Start dialog referencing the Taskdoc
dominds dialog start --taskdoc-path tasks/auth-system.tsk
```

**Development Phase**:

- Multiple dialog trees can reference the same Taskdoc
- Team members collaborate by updating the same Taskdoc (via `change_mind` operations)
- Progress tracking persists across conversations
- Requirements evolve through `change_mind` operations
- Workspace hard rules:
  - `*.tsk/**` is encapsulated Taskdoc state and is hard-denied for all general file tools.
  - `.minds/**` is reserved workspace state (team config/memory/assets) and is hard-denied for all general file tools; manage it via dedicated tools like `team-mgmt`.

**Collaboration Example**:

```yaml
# Dialog A (Backend specialist)
task_document: "tasks/auth-system.tsk"
focus: "JWT token service implementation"

# Dialog B (Frontend specialist)
task_document: "tasks/auth-system.tsk"
focus: "Login UI integration"

# Dialog C (DevOps specialist)
task_document: "tasks/auth-system.tsk"
focus: "Deployment and monitoring setup"
```

**Long-term Evolution**:

- Taskdocs survive team changes
- Persist through workspace reorganizations
- Maintain history of requirements evolution
- Support multiple parallel development efforts
- Reference other evolving product documentation

### Multi-Task Workspace Example

```
workspace/
├── tasks/
│   ├── auth-system.tsk/          # Authentication feature
│   ├── payment-integration.tsk/  # Payment processing
│   ├── mobile-app.tsk/           # Mobile application
│   └── performance-opt.tsk/      # Performance optimization
├── specs/
│   ├── api-design.md
│   └── ui-mockups.md
└── docs/
    ├── architecture.md
    └── deployment.md
```

Each Taskdoc represents an independent DevOps assignment that can be worked on in parallel, with multiple dialog trees collaborating on the same objectives while maintaining their own conversation contexts.

---

## Future Directions

### Enhanced Autonomous Capabilities

- **Advanced Self-Assessment**: Develop more sophisticated autonomous cognitive load assessment algorithms
- **Predictive Clarity Management**: Enable agents to predict when clarity operations will be needed and prepare proactively
- **Autonomous Learning**: Allow agents to learn and adapt their clarity strategies based on their own performance patterns
- **Self-Optimizing Hierarchies**: Enable dialog hierarchies to autonomously reorganize for optimal performance

### Autonomous Multi-Agent Coordination

- **Distributed Autonomous Consensus**: Develop protocols for autonomous agents to reach consensus on task direction changes
- **Self-Organizing Agent Networks**: Enable agents to autonomously form and dissolve collaboration networks based on task requirements
- **Independent Conflict Resolution**: Create mechanisms for autonomous agents to resolve conflicts without human intervention

### Advanced Autonomous Context Management

- **Intelligent Autonomous Context Compression**: Develop algorithms for agents to autonomously compress and preserve essential context
- **Self-Directed Context Sharing**: Enable agents to autonomously determine what context to share across dialog boundaries
- **Autonomous Memory Optimization**: Allow agents to independently optimize their memory usage and retention strategies

### Research Opportunities

#### Autonomous Cognitive Load Metrics

- **Self-Assessment Algorithms**: Quantitative measures for agents to evaluate their own cognitive state and decision-making quality
- **Performance Correlation**: Relationship between autonomous context quality and independent task performance
- **Optimal Autonomous Clarity Timing**: Research into when agents should independently trigger clarity operations for maximum benefit

#### Autonomous Multi-Agent Collaboration

- **Independent Coordination**: How autonomous agents can effectively coordinate without central control
- **Self-Organizing Mental Models**: Techniques for autonomous agents to maintain aligned understanding without explicit synchronization
- **Autonomous Trust Networks**: Building confidence and reliability in autonomous agent decision-making

#### Scalability and Autonomous Performance

- **Large-Scale Autonomous Dialog Management**: Clarity strategies for systems with hundreds of independently operating dialogs
- **Self-Optimizing Memory**: Autonomous memory usage optimization while maintaining context quality
- **Independent Real-Time Operations**: Minimizing latency in autonomous clarity operations for responsive systems

---

## Conclusion

The future of AI agent effectiveness lies not in larger context windows, but in smarter context management. By embracing concepts like proactive context clearing and Fresh Boots Reasoning, we can build agents that maintain clarity and focus throughout extended interactions.

Social Division of Labor for AI agents represents a fundamental shift from traditional monolithic approaches to cognitive architecture. The dominds system demonstrates that systematic mental clarity practices are not just nice-to-have features, but core architectural principles that enable autonomous, efficient, and reliable AI assistance.

The key insight is that AI agents, like humans, benefit greatly from mental hygiene practices. Regular cognitive cleanup and focused problem-solving sessions can dramatically improve both the quality and efficiency of agent reasoning. Fresh Boots Reasoning transforms the challenge of managing extensive conversational context into an advantage, allowing agents to bring fresh, focused attention to each aspect of complex problems while maintaining overall project continuity through the central Taskdoc.

As AI systems become more complex and are deployed in more demanding environments, the principles and patterns outlined in this document will become increasingly critical for success. The future belongs to AI agents that can think clearly, operate autonomously, and collaborate effectively through systematic approaches to cognitive management.
