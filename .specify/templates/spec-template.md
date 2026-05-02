# Feature Specification: [FEATURE NAME]

> Behaviour-first spec per [Constitution Principle IX](../memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Save implementation
> details for `plan.md`. Mark any unresolved questions with `[NEEDS CLARIFICATION: …]`.

**Feature ID**: `[short-slug]`
**Branch**: `feat/[short-slug]`
**Status**: `Draft` | `In Review` | `Approved` | `Implemented` | `Retrospective`
**Created**: YYYY-MM-DD
**Last updated**: YYYY-MM-DD
**Owner**: [GitHub handle]

---

## 1. Overview

One paragraph: what user-observable capability does this feature add or change?
Avoid implementation details — say "users can cancel a generation in flight",
not "we add a `cancelGeneration` controller".

## 2. User Scenarios

For each primary user, write a "Given / When / Then" scenario. Include the
unhappy-path scenarios (errors, race conditions, permission denials) — they
are part of the spec, not afterthoughts.

### 2.1 Primary scenarios

- **Given** [precondition], **when** [action], **then** [observable outcome].
- …

### 2.2 Edge cases & failures

- **Given** [precondition that's unusual], **when** [action], **then**
  [graceful behaviour the user sees].
- …

## 3. Functional Requirements

Numbered, atomic, testable. Each requirement is a sentence the system either
satisfies or does not. No "and" lists hiding multiple requirements.

- **FR-1** The system MUST [behaviour].
- **FR-2** The system MUST [behaviour].
- **FR-3** The system SHOULD [behaviour] — non-blocking but expected.
- **FR-4** The system MUST NOT [forbidden behaviour].

## 4. Non-Functional Requirements

- **Performance**: [e.g. "P95 < 500 ms for the cancel endpoint"]
- **Reliability**: [e.g. "successful generation rate ≥ 99% over a rolling 7-day
  window"]
- **Security & privacy**: which data is sensitive, who can read/write
- **Observability**: which events go to the activity log, which metrics fire
- **Compatibility**: which API versions / plugin SDK versions are required

## 5. Key Entities & Domain Concepts

For each new or changed concept, give a one-line definition. **No schema
columns** — that goes in the plan. Just the conceptual shape.

| Entity / concept | Description |
| ---------------- | ----------- |
| `[Name]`         | …           |

## 6. Out of Scope

Bullet list of things deliberately NOT in this feature. Counterintuitive
exclusions go here so reviewers don't waste time asking about them.

- …

## 7. Acceptance Criteria

Checklist a reviewer can run against the merged change.

- [ ] [Specific observable outcome 1]
- [ ] [Specific observable outcome 2]
- [ ] [Failure / unhappy-path outcome]
- [ ] All functional requirements have a passing test (unit or e2e).

## 8. Open Questions

Markers that block approval. Use the `[NEEDS CLARIFICATION: …]` form so they
can be grepped before merge.

- `[NEEDS CLARIFICATION: …]`

## 9. Constitution Gates

Tick each that applies; explain non-applicability for the rest.

- [ ] Plugin-first if introducing an external integration (Principle I)
- [ ] Capability-driven resolution if touching cross-plugin behaviour
      (Principle II)
- [ ] Source-of-truth repos preserved (Principle III)
- [ ] Long-running work via Trigger.dev (Principle IV)
- [ ] Schema changes ship as forward-only migrations (Principle V)
- [ ] Tests accompany the change (Principle VI)
- [ ] Secrets handled per `x-secret` rules (Principle VII)
- [ ] Plugin counts touch the canonical doc only (Principle VIII)
- [ ] Behaviour-first — no implementation in this spec (Principle IX)
- [ ] Backwards-compatible API/SDK/schema changes (Principle X)

## 10. References

- Related features: [links to other specs]
- Related ADRs: [`docs/specs/decisions/NNN-…`]
- Related architecture: [`docs/specs/architecture/…`]
- User-facing docs: [`docs/features/…`]
