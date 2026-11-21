# ODD Document Template & Risk Gate Reference

## 1. Fixed Document Order (`odd/tasks/<feature-name>.md`)

Keep stable specification content first and the append-only log last:

```markdown
# <Feature Title>

Objective: <2-3 lines: outcome, target behavior, constraints>.
Branch: <current branch>. Test runner: <exact commands>.
Does not change protected zones (`TitleBar.tsx` mode switcher).

## Specs

- **S1 — <Short spec name>**:
  - Verbatim:
    > "<Exact user request words, commands, or error strings without paraphrasing>"
  - Behavior: <Concrete observable behavior and acceptance criteria>.
  - Checks: <Exact deterministic tests or verification commands>.

## Tasks

- [ ] **T1** (`S1`, Risk: `item N (reason)` | `none`, route: `inline`): <Actionable task description>.
- [ ] **T2** (`S1`, Risk: `none`): <Verification & ODD closeout>.

## Log

- **L1 (<YYYY-MM-DD>)**:
  > "<User's verbatim opening request>"
```

---

## 2. The 6 High-Risk Categories

Check every diff (including untouched sibling paths sharing changed helpers, parsers, or options):

| Item | Trigger Condition |
| :--- | :--- |
| **1 — Data / Irreversible State** | Migrations, schema mutations, altering or deleting persisted user records (beyond appending new records or ephemeral dev caches). |
| **2 — Security** | Auth, credentials, secrets, tokens, permissions, guards, or sandbox boundaries. |
| **3 — Shared Contracts** | Modifying/removing public APIs, CLI flags, IPC commands, config schemas, or shared helpers/parsers consumed by existing features nobody asked to change. |
| **4 — Concurrency** | Locks, mutexes, race conditions, async ordering, cancellation/shutdown lifecycles. |
| **5 — Delivery & Environment** | Build installers, release scripts, CI workflows, dependencies (`Cargo.toml`, `package.json`), updater feeds. |
| **6 — Missing Test Coverage** | Runtime behavior change with no deterministic test capable of catching a regression. |

Count `unclear` as high risk if a bounded inspection cannot prove items `1`–`5` are safe.

---

## 3. Requirement Change & Differential Testing Rules

- **Requirement change**: append verbatim `## Log` entry -> edit only affected `S#` -> reopen/add only affected `T#` -> keep valid unrelated completed work intact.
- **Test-first policy**: when deterministic tests apply, observe RED before editing, make GREEN with minimal clean code, and verify existing behavior on every shared option/helper touched.
- **Cloud sandbox boundary (Google AI Studio / web IDEs)**: never invent test output. Mark local-only verification (`cargo test`, `verify:desktop:e2e`, `audit-references.mjs`) explicitly as `[NEEDS LOCAL VERIFICATION]`.
