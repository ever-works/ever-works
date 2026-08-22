# Task Breakdown: Governance Policy Matrices (Merge Policy + Tool Grants)

> Companion to [`./spec.md`](./spec.md) and [`./plan.md`](./plan.md).
> Shipped tasks are recorded for traceability; outstanding work is tracked at the
> bottom and cross-referenced to the spec's open questions.

**Feature ID**: `policy-matrices`
**Status**: `Implemented` (core), with follow-ups outstanding
**Last updated**: 2026-08-22

---

## How to use

Each task names the behaviour it delivers and the spec requirement it satisfies.
A task is done when its code **and** its tests are merged (Constitution
Principle VI — tests are a prerequisite, not a follow-up).

## Phase 1 — Contracts (types, constants, guards)

- [x] **T1** Define the merge-policy wire shape: `MergePolicy`,
      `MergePolicyOverride`, `MergePolicyScope`/`MergePolicySource`,
      `MergePolicyChainEntry`, `ResolvedMergePolicy`, `MergeDecision`. _(FR-7)_
- [x] **T2** Ship the frozen conservative platform default plus
      `MERGE_METHODS`, `MERGE_POLICY_SCOPE_PRECEDENCE` and
      `MERGE_POLICY_FIELDS`. _(FR-9, FR-10, FR-1)_
- [x] **T3** Ship `sanitizeMergePolicyOverride` implementing drop-if-unrecognised,
      trim + de-duplicate, and the empty-but-declared vs entirely-invalid split.
      _(FR-5, E3, E4, E5)_
- [x] **T4** Define the tool-grant wire shape: `ToolGrantOverride`,
      `ToolGrantMatrix`, scope/source types, chain + decision types. _(FR-15)_
- [x] **T5** Ship the frozen permissive platform default and
      `TOOL_GRANT_SCOPE_PRECEDENCE`. _(FR-16, FR-1)_
- [x] **T6** Ship `sanitizeToolGrantOverride` with the same posture as T3. _(FR-5)_
- [x] **T7** Ship the pattern matchers `matchesToolPattern`,
      `matchesAnyToolPattern` and `toolPatternCovers`, all case-insensitive.
      _(FR-19, FR-20)_
- [x] **T8** Ship `TOOL_NAME_PATTERN`, `TOOL_GRANT_PATTERN`,
      `CREDENTIAL_KEY_PATTERN`, `isCredentialKey` and the
      `credentialRefPattern()` **factory**. _(FR-24, FR-25, FR-26)_

## Phase 2 — Pure resolution & decision (agent package)

- [x] **T9** `resolveMergePolicyChain` — sorts layers into precedence, folds
      field-by-field over a defensive copy of the platform default, and reports
      the owning scope of every field. _(FR-2, FR-4, FR-6, FR-8)_
- [x] **T10** `evaluateAgentMerge` — the single decision point, with refusals
      ordered most- to least-fundamental, each carrying a stable code and a
      reason naming the offending value; never throws. _(FR-11, FR-12, FR-14)_
- [x] **T11** Branch normalisation: strip `refs/heads/`, compare
      case-insensitively, fail closed on an unknown target while branches are
      protected. _(FR-13, E1)_
- [x] **T12** Treat an omitted merge method as `merge`. _(E2)_
- [x] **T13** `narrowAllowPatterns` — exported separately because the split _is_
      the no-upward-widening rule, and a rule that cannot be tested in isolation
      is a rule nobody trusts. _(FR-17)_
- [x] **T14** `resolveToolGrantChain` — intersect `allow`, union `deny`, record
      rejected patterns per layer. _(FR-17, FR-18, FR-4)_
- [x] **T15** `decideToolGrant` — deny before allow, distinct code for an
      empty/non-string tool name. _(FR-21, FR-22, E8, E9)_
- [x] **T16** `partitionToolsByGrant` so no caller re-implements the ordering.
      _(FR-23)_

## Phase 3 — Services, repositories, wiring

- [x] **T17** `MergePolicyService` / `ToolGrantService` — the I/O half that loads
      the four scope rows and delegates to the pure functions.
- [x] **T18** `MergePolicyRepository` / `ToolGrantRepository`.
- [x] **T19** Injection tokens `MERGE_POLICY_ENFORCER` and `TOOL_GRANT_ENFORCER`
      as leaf files with type-only imports; bound by `PolicyModule`.
- [x] **T20** Consume via `@Optional() @Inject(...)` in `GitFacadeService`
      (merge policy) and `AgentRunService` / `AgentToolService` / `SkillsService`
      (tool grants) so an unbound token restores pre-feature behaviour. _(E7)_
- [x] **T21** `credential-resolver` / `credential-interpolation` — resolve
      `{{cred.<key>}}` server-side; never log, persist or echo the value. _(FR-24)_
- [x] **T22** `PullRequestGateService` consumes the merge decision. _(FR-11)_

## Phase 4 — Migrations

- [x] **T23** `AddMergePolicyColumns` — additive `simple-json` columns on the
      four scope tables. _(Principle V)_
- [x] **T24** `CreateToolGrants` — user-scoped grant table. _(Principle V)_

## Phase 5 — API surface

- [x] **T25** `GET /api/merge-policy/resolve`. _(FR-27)_
- [x] **T26** `GET /api/tool-grants/resolve`, `GET /api/tool-grants/check`,
      `GET /api/tool-grants`, `PUT /api/tool-grants`,
      `DELETE /api/tool-grants/:id`. _(FR-28)_
- [x] **T27** `GET /api/agents/:id/capabilities` reflects the resolved matrix.

## Phase 6 — Tests

- [x] **T28** Unit tests for the pure agent-package halves
      (`packages/agent/src/policy/__tests__/`).
- [x] **T29** Controller tests for the API surface
      (`merge-policy.controller.spec.ts`, `tool-grants.controller.spec.ts`).
- [x] **T30** Contracts-level unit tests pinning every exported constant list
      (members, count, order), both shape guards' empty-vs-invalid split, all
      three pattern matchers, the regex anchoring, and the
      `credentialRefPattern()` per-call-instance guarantee. _(AC-11)_

## Phase 7 — Docs

- [x] **T31** This Spec Kit feature (`spec.md` / `plan.md` / `tasks.md`) — the
      subsystem previously had only passing mentions in unrelated specs.

## Outstanding follow-ups

- [ ] **T32** _(OQ-1)_ Surface rejected allow patterns as an operator-visible
      warning, not only as a chain entry.
- [ ] **T33** _(OQ-2)_ Report a narrowing result for `deny` too, for symmetry.
- [ ] **T34** _(OQ-3)_ Validate merge-policy overrides at the API write boundary
      in addition to the read-time drop.
- [ ] **T35** _(OQ-4)_ Add an `audit-only` matrix mode that reports refusals
      without enforcing them, to de-risk a first rollout.
- [ ] **T39** _(OQ-5)_ Deep-freeze `PLATFORM_DEFAULT_MERGE_POLICY`'s
      `allowedMergeMethods` / `protectedBranches` arrays so they match
      `PLATFORM_DEFAULT_TOOL_GRANT` and a stray `.push()` throws instead of
      silently widening a safety control (spec E10).
- [ ] **T40** _(OQ-6)_ Decide whether `protectedBranches` should be case-normalised
      on write. Today dedup is case-sensitive at sanitize time while matching is
      case-insensitive at decision time, so `['main', 'MAIN']` stores two entries
      that behave as one.
- [ ] **T36** Settings UI for editing both matrices (spec §6 defers this).
- [ ] **T37** Integration test against a real Postgres covering the full
      four-scope load path (today's coverage is unit-level plus controller-level).
- [ ] **T38** End-to-end test asserting an agent is actually blocked from merging
      into a protected branch through the real git facade.

## Definition of Done

- Behaviour matches [`./spec.md`](./spec.md) §3 and satisfies §7's acceptance
  criteria.
- Schema changes shipped as forward-only migrations.
- Tests accompany the change and pin every constant, branch and refusal code.
- No secret value is logged, persisted or returned to the model.
