# Feature Specification: Governance Policy Matrices (Merge Policy + Tool Grants)

> Behaviour-first spec per [Constitution Principle IX](../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Implementation lives in [`./plan.md`](./plan.md).

**Feature ID**: `policy-matrices`
**Status**: `Implemented`
**Created**: 2026-08-22
**Last updated**: 2026-08-22
**Owner**: Ever Works Team

**Covers two sibling matrices that share one resolution model**:

- **Merge policy** (Wave 3, founder decision D4) — may an agent land a pull request?
- **Tool grants** (audit item G4) — may an agent call a given tool?

---

## 1. Overview

Autonomous agents in Ever Works can write code, open pull requests, call tools and
reach external systems. Two questions therefore need a single, auditable answer:

1. **May this agent merge this pull request?**
2. **May this agent call this tool?**

Both are answered by a **four-scope policy matrix** layered over a platform default:

```
platform default  <  tenant  <  organization  <  Work  <  Agent
```

An operator writes an override at whichever scope they care about; every scope
below inherits. Neither matrix is a hardcode — the platform ships a default and
every field of it is overridable.

The two matrices deliberately differ in one respect, because their risk profiles
differ:

|                            | Merge policy                                                     | Tool grants                                                                                   |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Platform default           | **Restrictive** (agents may not merge)                           | **Permissive** (`allow: ['*']`)                                                               |
| A more specific scope may… | set any field either way                                         | only **narrow**, never widen                                                                  |
| Why                        | merging is destructive and irreversible; opting in is deliberate | the matrix landed after tools already shipped, so it subtracts nothing until a row is written |

## 2. User Scenarios

### 2.1 Primary scenarios

- **S1 — Operator enables agent self-merge for one Work.** An operator sets
  `allowAgentMerge: true` on a single Work. That Work's agents may now merge;
  every other Work in the organization is unaffected, and the Work still inherits
  `requireGreenGate`, `requireHumanApproval`, the allowed methods and the
  protected-branch list from the platform default.
- **S2 — Operator restricts an agent to git tools only.** An operator sets
  `allow: ['git_*']` at the Agent scope. That agent may call `git_commit` and
  `git_push`; a call to `deploy_production` is refused with a reason naming the
  tool and the effective allow list.
- **S3 — Tenant bans a dangerous tool outright.** A tenant sets
  `deny: ['shell_exec']`. No organization, Work or Agent beneath it can re-enable
  that tool, even by declaring `allow: ['*']`.
- **S4 — Operator previews the effective policy.** Before relying on a rule, an
  operator asks the platform what the effective policy is for a given
  agent/Work/organization/tenant combination and receives both the resolved
  values **and** the chain that explains which scope contributed each field.
- **S5 — Agent attempts a merge into a protected branch.** The agent is refused
  with a stable machine-readable code and a human-readable reason naming the
  protected branch.

### 2.2 Edge cases & failures

- **E1 — Unknown target branch while branches are protected.** The decision
  **fails closed**: a policy that cannot be evaluated is never satisfied.
- **E2 — Merge method omitted.** Treated as `merge` (what every supported
  provider does by default), not waved through.
- **E3 — Stored override contains junk.** Unrecognised values are **dropped**
  (which means "inherit"), never coerced to a permissive default.
- **E4 — Override declares an empty list.** An explicitly empty list is
  **meaningful and kept**: `allowedMergeMethods: []` means "no method allowed",
  `protectedBranches: []` means "protect nothing", `allow: []` means "this scope
  grants nothing". This is deliberately distinct from E5.
- **E5 — Override declares a list that is entirely invalid.** Dropped (→
  inherit), because silently turning garbage into "grant nothing" would break a
  running tenant on a typo.
- **E6 — Child requests a tool its ancestors never granted.** The pattern is
  **rejected** rather than applied; the rejection is reported in the chain so the
  operator can see the request was refused rather than silently honoured.
- **E7 — Enforcement wiring absent.** With no enforcer bound (unit tests, the
  worker, any runtime without the policy module) every consumer behaves exactly
  as it did before the feature landed. An access matrix that failed **closed** on
  its own DI mistake would take the product down; the safe default is the
  permissive platform default, which is what the resolver returns anyway when
  there are no rows.
- **E8 — Empty or non-string tool name.** Refused with a distinct code rather
  than matched against the patterns.
- **E9 — Deny and allow both match a tool.** **Deny wins.** Otherwise a broad
  `allow: ['*']` at the tenant would defeat a targeted deny beneath it.
- **E10 — The two platform defaults are frozen to different depths.**
  `PLATFORM_DEFAULT_TOOL_GRANT` freezes its nested `allow`/`deny` arrays, so
  mutating them throws. `PLATFORM_DEFAULT_MERGE_POLICY` freezes only the outer
  object, so `PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches.push(...)`
  **silently succeeds** and corrupts the default for the whole process. The
  resolver never hits this (it clones before folding — FR-6), so it is latent
  rather than live, but it is an asymmetry a reader will not expect. Pinned by
  test as current behaviour; tightening it is tracked as OQ-5.

## 3. Functional Requirements

**Resolution (both matrices)**

- **FR-1** Four scopes resolve in the fixed order `tenant < organization < work < agent`.
- **FR-2** Layers may be supplied in **any** order; the resolver sorts them into
  the documented precedence so no caller can invert it.
- **FR-3** `null`, `undefined` and `{}` at any scope all mean **inherit**, never `false`.
- **FR-4** Resolution reports a **chain** attributing each contribution to a
  scope, plus a `source` naming the most specific scope that contributed
  anything (`'default'` when the whole chain was silent).
- **FR-5** Every stored override is validated on the way **in** to resolution;
  invalid values are dropped, never coerced (see E3–E5).
- **FR-6** A resolved policy is a **defensive copy**; callers can never mutate
  the frozen platform default.

**Merge policy**

- **FR-7** The policy has exactly five fields: `allowAgentMerge`,
  `requireGreenGate`, `requireHumanApproval`, `allowedMergeMethods`,
  `protectedBranches`.
- **FR-8** Merge-policy resolution is **field-by-field** (a deep merge, not a
  whole-object override): a Work that sets one field inherits the other four.
- **FR-9** The platform default is conservative and frozen:
  `allowAgentMerge: false`, `requireGreenGate: true`, `requireHumanApproval: true`,
  `allowedMergeMethods: ['squash']`,
  `protectedBranches: ['main', 'master', 'develop', 'stage']`.
- **FR-10** The supported merge methods are exactly `merge`, `squash`, `rebase`.
- **FR-11** There is exactly **one** decision point for "may this agent land this
  pull request". Every agent-driven merge path routes through it.
- **FR-12** Refusals are ordered most- to least-fundamental and each carries a
  stable code plus a reason naming the offending value:
  `agent-merge-disabled` → `target-branch-unknown` → `protected-branch` →
  `merge-method-not-allowed` → `gate-not-green` → `human-approval-required`.
- **FR-13** Branch comparison strips a `refs/heads/` prefix and is
  case-insensitive.
- **FR-14** The decision point never throws for policy reasons; a refusal is a
  returned value.

**Tool grants**

- **FR-15** An override stores two optional string arrays: `allow` and `deny`.
- **FR-16** The platform default is `allow: ['*']`, `deny: []` — permissive, so
  the matrix subtracts nothing until an operator writes a row.
- **FR-17** `allow` **narrows only**. A child's requested patterns are
  intersected with what its ancestors already cover; uncovered patterns are
  rejected and reported.
- **FR-18** `deny` is **additive and permanent**: once a scope denies a tool, no
  descendant can un-deny it.
- **FR-19** Pattern syntax is exactly: `*` (everything), `prefix*` (prefix
  match), or an exact name. Matching is **case-insensitive**, because a grant
  that silently misses on case is a security bug.
- **FR-20** The coverage test used for narrowing treats `*` as covering
  everything, `git_*` as covering `git_commit` and `git_*` but **not** `*` or
  `deploy_*`, and a concrete pattern as covering only the identical concrete
  pattern.
- **FR-21** Deny is evaluated **before** allow (E9).
- **FR-22** Refusals carry a stable code: `tool-name-invalid`, `tool-denied`, or
  `tool-not-granted`.
- **FR-23** A convenience partition splits a set of tool names into granted names
  and refusals, so no caller re-implements the deny-beats-allow order.

**Credential references**

- **FR-24** `{{cred.<key>}}` is the only credential-reference syntax the platform
  understands. It is resolved **server-side** immediately before an outbound
  call; the resolved value is never logged, never persisted and never echoed back
  to the model.
- **FR-25** The reference matcher is returned as a **factory**, not a shared
  constant, because a `/g` regex carries `lastIndex` state and a shared instance
  would silently skip matches on the second call.
- **FR-26** A credential key is alphanumeric plus `_`, `.` and `-`, 1–64 chars,
  and may not start with `.` or `-`.

**Operator surface**

- **FR-27** An operator can resolve the effective merge policy for a scope
  combination and receive the policy, its source and its chain.
- **FR-28** An operator can resolve the effective tool-grant matrix, check a
  single tool name against it, list stored grant rows, upsert a row and delete a
  row.

## 4. Non-Functional Requirements

- **NFR-1 — Pure and portable.** Resolution and decision logic is side-effect
  free, so it runs unchanged in the API, the worker, or a future edge caller, and
  is unit-testable without a database.
- **NFR-2 — Zero-dependency contracts.** The shape guards live next to the types
  in `@ever-works/contracts` so writers that only touch the contract (the API's
  organization update path, importers) never pull the agent package's entity
  graph in just to validate a few fields.
- **NFR-3 — Fails safe, not closed.** Missing enforcement wiring degrades to
  pre-feature behaviour (E7); a policy that cannot be _evaluated_ fails closed
  (E1). These are different situations and are handled differently on purpose.
- **NFR-4 — Actionable refusals.** Every refusal names the offending value. A
  refusal a user cannot act on is a bug report waiting to happen.
- **NFR-5 — Auditable.** Every resolution can explain itself via its chain.

## 5. Key Entities & Domain Concepts

| Concept                      | Meaning                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Scope**                    | One of `tenant`, `organization`, `work`, `agent` — the four places an override can live.                      |
| **Override**                 | What a scope stores: a _partial_ policy/matrix. Absent fields inherit.                                        |
| **Resolved policy / matrix** | The effective values after folding the chain over the platform default.                                       |
| **Chain**                    | The ordered, per-scope explanation of which layer contributed what — including patterns that were _rejected_. |
| **Source**                   | The most specific scope that contributed anything; `'default'` when none did.                                 |
| **Decision**                 | The answer at the single decision point: allowed, or refused with a stable code and a human reason.           |
| **Narrowing**                | The no-upward-widening rule: a child may only keep allow patterns an ancestor already covers.                 |

## 6. Out of Scope

- Per-tool **rate limits** or quotas (grants are boolean reachability, not budget).
- **Approval workflows** themselves — the merge policy consumes a
  `humanApproved` fact; producing it is the escalation/HITL feature's job.
- **Quality-gate computation** — the merge policy consumes a `gateStatus`; the
  gate that computes it is a separate feature.
- Retroactive enforcement over **already-merged** pull requests.
- A UI for editing matrices (the HTTP surface exists; the settings screens are
  tracked separately).

## 7. Acceptance Criteria

- **AC-1** With no rows stored anywhere, the resolved merge policy equals the
  platform default and its source is `'default'`.
- **AC-2** With no rows stored anywhere, the resolved tool-grant matrix is
  `allow: ['*'], deny: []` — i.e. behaviour is identical to before the feature.
- **AC-3** A Work that sets only `allowAgentMerge: true` resolves with that field
  owned by the Work scope and the other four still owned by `'default'`.
- **AC-4** Layers supplied in reverse order resolve identically to layers
  supplied in precedence order.
- **AC-5** `allowedMergeMethods: []` resolves to an empty allowed list (E4),
  while `allowedMergeMethods: ['nonsense']` is dropped and the field inherits (E5).
- **AC-6** An agent merge into `refs/heads/MAIN` is refused with
  `protected-branch` when `main` is protected (FR-13).
- **AC-7** A merge with no target branch, while any branch is protected, is
  refused with `target-branch-unknown` (E1).
- **AC-8** A child declaring `allow: ['*']` beneath a parent allowing only
  `git_*` keeps nothing and reports `*` as rejected (FR-17, FR-20).
- **AC-9** A tool denied at the tenant is refused for an agent that allows `*`
  (E9/FR-18).
- **AC-10** Two consecutive calls to the credential-reference factory each find
  every match in the same input (FR-25).
- **AC-11** Both platform defaults are frozen at the top level;
  `PLATFORM_DEFAULT_TOOL_GRANT`'s nested arrays are frozen and
  `PLATFORM_DEFAULT_MERGE_POLICY`'s are not (E10) — pinned so the asymmetry
  cannot change unnoticed in either direction.
- **AC-12** Every exported constant list, decision code and pattern is pinned by
  a unit test, so a silent addition or reorder fails CI (Principle VI).

## 8. Open Questions

- **OQ-1** Should a rejected allow pattern (E6) also raise an operator-visible
  warning, rather than only appearing in the chain? Today it is silent unless the
  chain is inspected.
- **OQ-2** Should `deny` support the same narrowing report as `allow`, for
  symmetry in the chain output?
- **OQ-3** Merge-policy overrides are stored in `simple-json` columns, which
  round-trip whatever was written. Should a write-time validation reject junk at
  the API boundary in addition to the read-time drop?
- **OQ-4** Should the tool-grant matrix gain an explicit `audit-only` mode that
  reports refusals without enforcing them, to de-risk a first rollout?
- **OQ-5** Should `PLATFORM_DEFAULT_MERGE_POLICY` deep-freeze its
  `allowedMergeMethods` / `protectedBranches` arrays to match
  `PLATFORM_DEFAULT_TOOL_GRANT` (E10)? Today a stray `.push()` on either array
  would widen a safety control process-wide and fail silently.
- **OQ-6** `protectedBranches` is de-duplicated **case-sensitively** on the way
  in, but matched **case-insensitively** at decision time (FR-13). So
  `['main', 'MAIN']` stores two entries that behave as one. Should the
  sanitizer normalise case on write, or is preserving the operator's
  original casing for display the better trade-off?
- **OQ-7** `isCredentialKey(value)` is `CREDENTIAL_KEY_PATTERN.test(value)`, and
  `RegExp.test` **stringifies its argument**. So `isCredentialKey(undefined)`
  returns `true` (the string `'undefined'` matches the pattern), as do `null`,
  `123`, `true`, `false` and a one-element array. Both current call sites are
  protected by other means — `checkToolCredentialDeclarations` reads keys from
  `Object.entries`, and `EnvCredentialResolver` would crash a moment later in
  `key.replace(...)` rather than resolve anything — so this is a latent
  robustness hole in a **security gate**, not a live credential leak. Should
  the guard reject non-strings explicitly (`typeof value === 'string' && …`)?

## 9. Constitution Gates

- [ ] **Plugin-first (I)** — n/a. This is core governance, not an external
      integration; it has no provider to swap.
- [ ] **Capability-driven resolution (II)** — n/a. Resolution here is over
      _scopes_, not plugin capabilities.
- [x] **Source-of-truth repos preserved (III)** — the matrices gate what an agent
      may do _to_ a repository; they never bypass the repo as source of truth.
- [ ] **Long-running work via the job runtime (IV)** — n/a. Resolution and
      decision are synchronous, pure and sub-millisecond.
- [x] **Forward-only migrations (V)** — the stored columns/tables ship as
      forward-only migrations (`AddMergePolicyColumns`, `CreateToolGrants`).
- [x] **Tests accompany the change (VI)** — the pure halves are unit-tested
      without a database; see AC-12.
- [x] **Secrets per `x-secret` rules (VII)** — credential references are resolved
      server-side and never logged, persisted or echoed to the model (FR-24).
- [ ] **Plugin counts (VIII)** — n/a, no plugin counts touched.
- [x] **Behaviour-first (IX)** — this document states behaviour; structure lives
      in [`./plan.md`](./plan.md).
- [x] **Backwards compatible (X)** — the tool-grant default subtracts nothing,
      and an unbound enforcer preserves pre-feature behaviour exactly (E7).

## 10. References

- Related features: [`agents`](../agents/spec.md), [`agent-plugins`](../agent-plugins/spec.md),
  [`tenants-and-organizations`](../tenants-and-organizations/spec.md),
  [`git-operations`](../git-operations/spec.md)
- Implementation plan: [`./plan.md`](./plan.md)
- Task breakdown: [`./tasks.md`](./tasks.md)
