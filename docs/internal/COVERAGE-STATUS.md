# Coverage Status — refreshed inventory (2026-08-22)

> **Supersedes the inventory in [`COVERAGE-TRACKER.md`](./COVERAGE-TRACKER.md)**,
> whose last refresh was 2026-05-09 / ~PR #600. `develop` is now at ~PR #2150, so
> that file's counts, "pending" lists and per-module claims are three months and
> ~900 commits stale. Its **Done** ledger is still valid history; its
> **Pending** sections should be read against this file.
>
> Maintained by the hourly `platform-tests-and-docs` scheduled task.

## How an hourly run uses this file

1. Read this file first.
2. Take the top unclaimed item from **Priority queue** below.
3. Ship it in one PR to `develop` (the scheduled task is authorised to merge
   without waiting for review).
4. Update this file in the same PR: move the item to **Recently shipped**, and
   re-run the scan (command below) if the inventory looks stale.

## Regenerating the inventory

The numbers below come from a per-package scan that pairs each source file with
a test file of the same basename anywhere in that package (so
`foo.service.ts` ↔ `__tests__/foo.service.spec.ts` counts, wherever the test
lives). It is a **proxy for coverage, not a coverage report** — see the caveats.

## Inventory (2026-08-22)

| Package               | src files | with sibling test |  missing | proxy cov |
| --------------------- | --------: | ----------------: | -------: | --------: |
| `packages/agent`      |       844 |               491 |      353 |     58.2% |
| `apps/api`            |       601 |               226 |      375 |     37.6% |
| `packages/tasks`      |        75 |                21 |       54 |     28.0% |
| `packages/monitoring` |        17 |                 8 |        9 |     47.1% |
| `packages/cli-shared` |         8 |                 6 |        2 |     75.0% |
| `apps/internal-cli`   |        48 |                14 |       34 |     29.2% |
| `apps/mcp`            |        33 |                 8 |       25 |     24.2% |
| `apps/cli`            |        38 |                 6 |       32 |     15.8% |
| `packages/plugin`     |       126 |                15 |      111 |     11.9% |
| `packages/contracts`  |        92 |                 5 |       87 |      5.4% |
| **Total (excl. web)** |  **1882** |           **800** | **1082** | **42.5%** |

`apps/web` is deliberately excluded from that table: it carries **762 Playwright
e2e specs** in `apps/web/e2e/` plus **210 unit specs** under `src/`. Those e2e
files are named by _scenario_, not by component, so basename pairing reports a
false ~4% for it. Web coverage should be judged by e2e scenario breadth, not by
this metric.

### Caveats — read before trusting the table

- **Migrations inflate the API gap.** 150 of `apps/api`'s 375 "missing" files are
  `src/migrations/*`, which are not unit-tested by design. Excluding them,
  `apps/api` sits at roughly **50%** (225 missing of 451).
- **Type-only files inflate the contracts/plugin gaps.** Much of
  `packages/contracts` and `packages/plugin/src/contracts` is interfaces and type
  aliases with zero runtime surface; those files cannot have a meaningful unit
  test. The _runtime_ exports in them (constants, guards, matchers, clamps) very
  much can, and that is where the real gap is.
- **A sibling test does not mean the file is well covered.** This metric answers
  "does a test file exist for this name", not "are its branches exercised".

## Priority queue

Ordered by value per PR: zero-coverage directories with real runtime logic
first, type-only barrels last.

### High — zero/near-zero coverage with real runtime logic

- [x] `packages/contracts/src/policy` — 6 files, **zero** spec coverage. Two
      shape guards with subtle empty-vs-invalid semantics, three pattern
      matchers, three regexes, four constant lists. _Shipped 2026-08-22 (this run)._
- [x] `packages/contracts/src/kb` — 10 files, 1 spec. `kb-document-class.ts`
      holds 9 constant lists incl. a `satisfies` invariant worth pinning at
      runtime. _Shipped 2026-08-22 (this run)._
- [x] `packages/contracts/src/fleet` — 6 files, 1 spec. `clampLeaseTtlSec`,
      `clampMaxAttempts`, `nodeSatisfiesCapabilities`, `isNodeBusy`,
      `summarizeRunnerStatus` all encode leasing safety. _Shipped 2026-08-22 (this run)._
- [ ] `packages/plugin/src/facades` — 14 files, no specs. Facade resolution is
      the capability-driven core (Constitution Principle II).
- [ ] `packages/plugin/src/pipeline` — 12 files, no specs.
- [ ] `apps/api/src/fleet` — 12 files missing, incl. `fleet-run-router.service.ts`
      (320 LOC), `fleet-agent-task.dispatcher.ts`, both guards, and
      `fleet-capability.validators.ts`.
- [ ] `apps/api/src/organizations` — 13 files missing, incl.
      `company-import.service.ts` (492 LOC) and 6 DTOs.
- [ ] `apps/api/src/webhooks` — `webhook-event-dispatcher.service.ts` (336 LOC)
      and `webhooks.controller.ts` (222 LOC).
- [ ] `apps/api/src/health` — `build-info.ts`, `service-detection.ts`, both
      indicators. Small, pure, fast wins.
- [ ] `packages/agent/src/agents` — 22 files missing, incl. `loop-detector.ts`
      (264 LOC), `escalation-confidence.ts` (253 LOC), `role-seeding.ts` (269 LOC).
- [ ] `packages/agent/src/policy` — 8 files missing on the agent side
      (`tool-credentials.ts` 181 LOC, `tool-grant.repository.ts` 109 LOC,
      `credential-resolver.ts`, both enforcer-adjacent helpers).
- [ ] `packages/agent/src/user-research` — `user-research.service.ts` (352 LOC),
      `work-proposal.repository.ts` (338 LOC), 3 tools.
- [ ] `packages/agent/src/tasks-domain` — `task-gate-judge.service.ts` (258 LOC),
      `agent-task-tools.ts` (254 LOC), `acceptance-check-executor.ts` (186 LOC).
- [ ] `packages/tasks/src/tasks` — 35 files missing (largest single gap in that
      package).
- [ ] `apps/cli/src/commands` — 29 files missing.
- [ ] `apps/internal-cli/src/commands` — 26 files missing.
- [ ] `apps/mcp/src/tools` + `src/openapi-tools` — 13 files missing.
- [ ] **Wire spec type-checking into CI.** The contracts package's
      `type-check:tests` script passes today. Either add it to the CI job or fold the
      spec glob back into the package `tsconfig.json`, and give the other
      packages the same treatment — several exclude their specs the same way.
- [ ] **Cross-package mirror guard for the KB vocabularies.** `packages/contracts/src/kb/kb-document-class.ts` is a hand-maintained mirror of
      the agent-side enums in `packages/agent/src/entities/kb-types.ts`, and nothing at build time proves they still agree (contracts is zero-dependency and
      cannot import the agent). Verified in sync on 2026-08-22. The right guard is a test in `packages/agent` (which _can_ import contracts) asserting each
      `Object.values(KbXxx)` equals its contracts counterpart.

### Medium — docs & specs

- [x] Spec Kit feature for the governance policy matrices (merge policy + tool
      grants) — the subsystem had only passing mentions in unrelated specs.
      _Shipped 2026-08-22 (this run) at `docs/specs/features/policy-matrices/`._
- [ ] Cross-check `docs/specs/features/` (74 entries) against
      `docs/specs/README.md`'s index table — the table lists only ~25 of them.
- [ ] Spec Kit feature for `fleet` (nodes, jobs, leasing, execution preference) —
      large implemented subsystem, no dedicated feature folder.
- [ ] Spec Kit feature for `organizations` / company import.
- [ ] `docs/api/*` — re-cross-check against the current controller set; several
      modules (`fleet`, `tool-grants`, `merge-policy`, `webhooks`,
      `organizations`) have no endpoint reference page.

### Low

- [ ] Admin app (`apps/admin`) — currently has no `src/`.
- [ ] Performance / load tests for the standard pipeline.
- [ ] Visual-regression for marketing pages.

## Source defects surfaced by coverage work

Pinned as current behaviour in tests (so a fix is a visible, intentional change)
and filed against the owning feature spec rather than fixed inside a tests-only PR.

| Where                                                              | Defect                                                                                                                                                                                                                                                                                                                                                           | Filed as                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `packages/contracts/src/policy/tool-grant.types.ts`                | **FIXED 2026-08-23** — `isCredentialKey` used `RegExp.test`, which stringifies, so `isCredentialKey(undefined)` returned `true`; a security gate that admitted non-strings. Now `(value: unknown): value is string` with an explicit `typeof` guard.                                                                                                             | policy-matrices OQ-7 / T41 |
| `packages/contracts/src/policy/merge-policy.types.ts`              | `PLATFORM_DEFAULT_MERGE_POLICY` is shallow-frozen, so `.protectedBranches.push()` silently widens a safety control process-wide. `PLATFORM_DEFAULT_TOOL_GRANT` deep-freezes.                                                                                                                                                                                     | policy-matrices OQ-5 / T39 |
| `packages/contracts/src/policy/merge-policy.sanitize.ts`           | `protectedBranches` de-duplicates case-sensitively but matches case-insensitively.                                                                                                                                                                                                                                                                               | policy-matrices OQ-6 / T40 |
| `packages/contracts/src/fleet/fleet-jobs.types.ts`                 | `nodeSatisfiesCapabilities` fails **open** on a non-array required-capabilities list, contradicting its "fail-closed by construction" doc.                                                                                                                                                                                                                       | needs a fleet spec         |
| `packages/contracts/src/fleet/fleet-execution-preference.types.ts` | `decideFleetRouting` reports `no-runners` when `total <= 0` even if `online > 0`; `resolveFleetExecutionMode` makes an empty-string `scopeId` permanently unresolvable.                                                                                                                                                                                          | needs a fleet spec         |
| `packages/contracts/src/kb/kb-memory-facets.ts`                    | `deriveKbMemorySourceBadge` is documented "Deterministic, total" but is not: it reads `input.metadata` unguarded, so a null/undefined row throws before any rule runs. A wrong-**typed** `tags` or `path` also throws — the `?? []` / `?? ''` defaults cover nullish, never wrong types. Bounded: only agent rows without provenance can reach it.               | needs a KB spec            |
| `packages/contracts/src/fleet/fleet-agent-credentials.types.ts`    | `resolveExclusiveAgentCredentials` throws on a nullish `grantedNames` (at the trailing `.filter`, not at `new Set`), and is _inconsistent_ on a nullish `env` — it returns normally unless a family name is granted, because `granted.has(name) &&` short-circuits first. Also `.trim()` is applied only to the blank test, so a padded value counts as present. | needs a fleet spec         |

## Recently shipped

| Date       | Area                                       | What                                                                                         |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 2026-08-22 | `packages/contracts/src/{policy,kb,fleet}` | Unit specs for the three lowest-coverage contract areas (see PR body for per-file breakdown) |
| 2026-08-22 | `docs/specs/features/policy-matrices/`     | New Spec Kit feature: spec.md + plan.md + tasks.md for merge-policy + tool-grant governance  |

## Conventions for tests added by this task

- **Contracts / plugin / tasks packages** use **vitest**; specs live at
  `src/<area>/__tests__/<source-basename>.spec.ts` and import relatives with a
  `.js` suffix (ESM).
- **Spec files are NOT type-checked by the default commands.** This trips people
  up, so verify deliberately: - `packages/contracts/tsconfig.json` **excludes `**/\*.spec.ts`**, so
`pnpm type-check`never sees a spec.
    -`vitest.config.ts`sets`typecheck.include: ['src/**/*.spec-d.ts']`, so the
      reassuring `Type Errors: no errors`line in`vitest run`output covers only
      the`.spec-d.ts`type fixtures — **not** your`.spec.ts` files.
    - Use **`pnpm --filter @ever-works/contracts type-check:tests`** (added
      2026-08-22, backed by `tsconfig.speccheck.json`) to actually type-check the
  specs. The package is clean under it today; promoting it to a CI gate is a
  deliberate follow-up, not something to do silently.
- **`packages/agent` and `apps/api`** use **jest**.
- **`apps/web`** uses Playwright for e2e.
- Pin literal members, counts and ordering of exported constant lists so a silent
  addition fails CI.
- Prefer mocking the upstream SDK or `global.fetch` over network round-trips.
- Run `pnpm format:check` before pushing — CI checks formatting on **every** PR,
  including docs-only ones.
- Branch naming `tests/<area>-<slug>`; PR title `test(<scope>): <summary>`.
- Always merge to `develop` without waiting for human review.
