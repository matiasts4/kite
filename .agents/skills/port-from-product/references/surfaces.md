# Clean-Room Surface Checklist

Evaluate every applicable row twice—once as the end user and once as an agent executing inside the system—before writing specs or code.

## 1. Delivery — How Capability Enters
- CLI arguments, subcommands, flags, stdout/stderr receipts, and help text.
- Environment gates and variables read/injected at runtime.
- Instruction channels (system prompts, `AGENTS.md`, `.agents/skills/*/SKILL.md`).
- Typed IPC / schemas / validation parity with UI actions.

## 2. Observation — How State Is Read
- Live status & presence accuracy vs optimistic assumptions.
- Non-blocking read/tail/wait semantics and timeouts.
- System notices, error banners, blocked approvals, and permission requests.

## 3. Presentation — Visual & Interaction Design
- Motion/animation, reduced-motion fallback, compact vs standard viewport geometry.
- Empty, loading, waiting, failed, interrupted, and settled states.
- Consistency with Kite Code `AGENTS.md` radius/height contracts and protected zones.

## 4. Lifecycle & Persistence
- Spawn / follow-up steering / interrupt / kill / worktree cleanup.
- Parent-child propagation, cascade cancellation, and crash/restart state recovery.
- Persistence schema, migration, backward compatibility, and cache invalidation.

Table format for output:
`Surface | Desired Behavior | Current Gap in Kite | Keep or Defer`
