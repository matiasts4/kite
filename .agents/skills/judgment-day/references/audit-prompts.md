# Judgment Day — Review Pass Prompts & Verdict Format

## Judge A (Correctness, Contracts, Security & Concurrency)

Inspect ONLY the frozen target scope. Verify every claim against actual file lines read:
- Off-by-one, null/undefined guards, error handling, silent failures, and unreachable cleanup.
- Broken shared contracts (IPC payloads, Rust types vs TypeScript interfaces, CLI flags).
- Race conditions, stale closures, lock ordering, missing cleanup on unmount/abort.
- Security/hygiene leaks (hardcoded credentials, path traversal, unsanitized external references).

Emit concrete findings:
`{ location: "path:line", severity: "CRITICAL|HIGH", claim: "...", proof: "..." }`

---

## Judge B (Architecture, Maintainability, UI Standards & Edge Cases)

Independently inspect ONLY the frozen target scope:
- Duplicated logic that violates DRY; deep nesting or oversized multi-purpose functions.
- Violated `AGENTS.md` rules (arbitrary border radii, arbitrary control heights, protected `TitleBar.tsx` modifications, ODD sync gaps).
- Boundary cases, empty states, reduced motion, RTL/overflow clipping, test gaps (tests asserting implementation trivia rather than behavior).

---

## Verdict Summary Shape

```markdown
- Target: <commit SHA or path list>
- Round: <1 | 2>
- Confirmed Severe: <count + path:line list>
- Single-Lens / Suspect: <count>
- INFO / Suggestions: <count>
- Checks Observed: <exact commands + results or [NEEDS LOCAL VERIFICATION]>
- Verdict: JUDGMENT: APPROVED | JUDGMENT: ESCALATED
```
