# Task Breakdown: App Provisioner

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests per
> **Constitution VI**. The schema task ships its migration in the same PR per **Constitution V**.

**Epic ID**: `APW-04-app-provisioner`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17 (program audit fix pass — CONTRACTS.md §0 R-1…R-24 applied)

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify (**Create** / **Modify**; **(new)** marks a file this epic
  creates), the test that proves it (**Test** — for a test-only task, the command that runs it) and an observable
  **Done when**.
- Add new tasks at the bottom rather than renumbering (T46+ were added by the program audit; T48+ by the APW-04 gap
  audit — each names its phase and the tasks it lands with).
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- Cross-epic preconditions are listed per phase; do not implement another epic's owned names here (CONTRACTS.md). The
  verification hooks — APW-05 `startBuild({ verification })`, APW-06 `AppRenderInput.purpose: 'verification'`, APW-07's
  ephemeral `AppRuntimeEnvSource` mode — are accepted (Resolution R-10) and built by their owners; this epic consumes
  them.
- Catalog tasks (T30–T32) land in `ever-works/agents` and `ever-works/skills`, not in this monorepo.
- Test commands: agent package `pnpm --filter @ever-works/agent test -- <pattern>` (Jest); API
  `pnpm --filter ever-works-api test -- <pattern>` (Jest); worker `pnpm --filter @ever-works/trigger-tasks test -- <pattern>` (Vitest); web unit `pnpm --filter ever-works-web test -- <pattern>` (Vitest); web e2e
  `pnpm --filter ever-works-web test:e2e -- <file>` (Playwright, `apps/web/e2e/`). Nothing is placed under
  `apps/api/test/` (R-22).
- Binding program resolutions ([CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):
  R-1 contracts in `packages/contracts/src/apps/`; R-2 `actionType: 'app_provision'`; R-10 hooks accepted; R-13 `auto`;
  R-17 safety rails; R-22 test locations.

---

# Phase P0 — Prerequisites (inert until P1)

_No user-visible change. Each task is independently shippable._

- [ ] **T1. Pipeline networking flag and sandbox session runner contract.**
      **Modify** `packages/plugin/src/contracts/capabilities/pipeline-plugin.interface.ts` — add optional
      `readonly enforcesRuntimeNetworking?: boolean` to the pipeline plugin contract with a doc comment ("true only when
      the plugin turns `runtimeEnvironment.networkingMode = 'limited'` into an enforced sandbox policy"), **and** the
      optional `runSandboxSession?(input, signal)` method with the `SandboxSessionInput` /
      `SandboxSessionResult` shapes of plan §2.6 (additive: every existing pipeline is unaffected).
      **Modify** `packages/plugins/claude-managed-agent/src/claude-managed-agent.plugin.ts` — declare `true` and
      implement `runSandboxSession` on the primitives the plugin already has (`resolveManagedAgentSettings`,
      `ensureControlPlane` with the pre-resolved environment, `buildSessionResources`, `createSession` with `budgetUsd`
      and an **ephemeral** agent + environment, `sendUserMessage` / `waitForSessionIdle`, `extractAgentTranscript`,
      `toManagedSessionTokenUsage`); a `requires_action` idle event returns `failed` with `requiresAction` instead of
      throwing, and the last assistant message comes back as `finalText`.
      **Test**: `packages/plugins/claude-managed-agent/src/claude-managed-agent.plugin.runtime-environment.spec.ts` —
      assert the flag and that a `limited` environment produces a `limited` policy with `allow_mcp_servers: false`
      (ACC-04-05, unit half); a new `claude-managed-agent.plugin.run-sandbox-session.spec.ts` **(new)** with a client
      double — the system prompt, the one tokenless repository mount and the budget are sent, `requires_action` returns
      `failed/requiresAction`, and usage maps to `{ inputTokens, outputTokens, costUsd }`.
      **Done when**: no other pipeline plugin declares the flag or implements the method (grep), and the plugin package
      builds.

- [ ] **T2 (parallel). Repo-backed agent template instantiation.**
      **Modify** `packages/agent/src/agents/agent-templates.service.ts` — add
      `createFromRepoTemplate(userId, slug, input, ownershipScope?)` reading `templates/<slug>/.works/agent.yml`,
      `SOUL.md` and `skills.yml` at `EVER_WORKS_AGENTS_REF` with the same tokenless-raw / App-installation fallback as
      `apps/api/src/agents/agent-template-catalog.service.ts`; validate the manifest's required keys; strip HTML; cap
      lengths; write `SOUL.md` via `AgentFileService.write`; permissions all false; guardrails `require_approval`.
      Only slugs in `REPO_TEMPLATE_INSTANTIABLE_SLUGS = ['app-provisioner']` are accepted (404 otherwise).
      **Create** `packages/agent/src/agents/repo-agent-template.reader.ts` **(new)** — the fetch + parse helper
      (pure parse functions exported for tests).
      **Test**: `packages/agent/src/agents/__tests__/agent-templates.repo-template.spec.ts` **(new)** — allow-list,
      missing required key → refused, HTML stripped, SOUL written, existing `createFromTemplate` untouched.
      **Done when**: `packages/agent/src/agents/__tests__/agent-templates.service.spec.ts` passes unchanged.

- [ ] **T3 (parallel). Worker branch for provisioning Tasks (inert).**
      **Modify** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` — before `provisionForRun`, look up a
      provisioning row by `taskId` through a port (`APP_PROVISIONING_LOOKUP_PORT`, resolved `@Optional()`); when found,
      skip workspace provisioning, the L0 pre-check and the gate loop, and do **not** run the default post-run
      `finalizeRun` — finalize is deferred to the job, which pushes and opens the pull request through the Task finalize
      variants of T16 (R-17); call `AppProvisionSessionRunner.run(runId)` (T48) **instead of** `runner.execute(...)` — the
      pre-resolved `runtimeEnvironment` and the row's `attachedRepos` reach the sandbox there and nowhere else — and on
      completion call `notify({ event: 'run-finished' })`. There is no fallback to `runner.execute` for a provisioning
      Task.
      **Create** `packages/agent/src/app-provisioning/app-provisioning-lookup.port.ts` **(new)** — interface + symbol.
      **Test**: `packages/tasks/src/__tests__/agent-task-execute.provisioning-branch.spec.ts` **(new)** — a Task with
      a row takes the branch and never calls the agent `commitToRepo` / `openPullRequest` tools, and never calls
      `AgentRunService.execute`; a Task without a row runs the existing path byte-for-byte (golden assertions on the
      calls).
      **Done when**: `packages/tasks/src/__tests__/agent-task-execute.task.spec.ts` passes unchanged.

- [ ] **T4. Sandbox isolation live spec (runnable root — R-22).**
      **Create** `packages/plugins/claude-managed-agent/src/provision-sandbox-isolation.live.spec.ts` **(new)** —
      `describe.runIf(process.env.APW_E2E_LIVE === '1')` (skipped in the PR lane); opens a real managed session through
      T1's `runSandboxSession` with the plan §7.3 environment and **one fixed model turn** whose deterministic
      tool-use instruction probes the network (the managed-agents client exposes only `sendUserMessage` and
      `waitForSessionIdle`, both model turns, and no command-execution API): the platform API origin taken from
      `APW_E2E_ALLOWED_BASE_URLS`, an RFC1918 address, `169.254.169.254` and an unlisted public host must fail;
      `github.com` and `registry.npmjs.org` must succeed; environment names and `git config --list` are passed through
      `scanForSecrets` with zero matches; a control case with `networkingMode: 'unrestricted'` must see the unlisted
      host succeed. Settings come from the plugin-config seam (`resolveManagedAgentSettings`), falling back to
      `APW_E2E_MANAGED_AGENT_API_KEY` (ACCEPTANCE.md:120) when no plugin setting is present; with neither, the spec
      reports **skipped**, never failed.
      **Test**: `APW_E2E_LIVE=1 pnpm --filter @ever-works/claude-managed-agent-plugin test -- provision-sandbox-isolation.live`
      on the nightly lane (ACC-04-05, ACC-04-06); without `APW_E2E_LIVE` the file reports skipped, never failed.
      **Done when**: the nightly lane runs it green and the recorded control run shows the unrestricted case reaching the
      unlisted host; no file for this check exists under `apps/api/test/`. The lane step itself is requested from APW-13
      (its job list is `interlocks → fixture → umami → safety → cleanup → evidence`) — until that step exists on the lane,
      the live half is recorded as **not yet observed**, never assumed.

- [ ] **T5. P0 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-04-app-provisioner/tasks.md` (tick T1–T4) and the APW-04 row of
      `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: all five commands are green on the P0 merge commit.

---

# Phase P1 — Provision, verify in the build runner, ask (Wave 1)

_Delivers spec FR-1…FR-50, FR-56…FR-62 with the runner verification target; ACC-04-01…20, 22…29, 32…38._
**Preconditions**: APW-01 P1 (kind `app`, creation hook), APW-03 P1 (`validateAppSpecDocument`, validate endpoint,
`packages/contracts/src/apps/index.ts`), APW-05 P1 (`IBuildPlugin` with the `verification` option and
`supportedStrategies`), APW-07 P1 (`AppRuntimeEnvSource` ephemeral mode, ephemeral dependency containers for the
runner) — the R-10 hooks.

## P1.1 — Contracts, entity, migration

- [ ] **T6. Contracts.**
      **Create** `packages/contracts/src/apps/app-provisioning.ts` **(new)** with the unions (incl.
      `APP_PROVISIONING_PARK_REASONS`, `APP_PROVISIONING_DETECTION_SOURCES` with `auto`, question reason `safety-rail`),
      the singular type aliases, `AppProvisioningAttempt`, `AppProvisioningStepView`,
      `AppProvisioningAttemptView`, `AppProvisioningQuestionView`, `AppProvisioningView`,
      `AppProvisioningSummaryView`, `AppProvisioningReadiness`, `AppProvisioningResponse`,
      `APP_PROVISION_LIMITS` (incl. `startDedupeMs: 10_000`), `APP_PROVISION_WRITABLE_PATHS`,
      `APP_PROVISION_PRESERVED_SPEC_FIELDS`, and the four `*_I18N_KEY` maps — exactly as plan §3.2.
      **Create** `packages/contracts/src/apps/app-provisioning-copy.ts` **(new)** per T49.
      **Modify** `packages/contracts/src/apps/index.ts` (created by APW-03 T1) — `export * from './app-provisioning.js';`
      and `export * from './app-provisioning-copy.js';` (R-1: no `src/app-works/` folder).
      **Test**: `packages/contracts/src/apps/__tests__/app-provisioning.spec.ts` **(new)** — pins every union, the
      singular aliases, **every key of every view interface** (so T23 can assert key-set equality against the wire),
      `publicRepository` in the readiness keys, `private-repository` in the failure reasons, and every numeric limit
      including `startDedupeMs` (a limit cannot change without a deliberate edit).
      **Done when**: `import { APP_PROVISION_LIMITS, AppProvisioningResponse } from '@ever-works/contracts'` resolves in
      `apps/api` and `apps/web`.

- [ ] **T7. `WorkAppProvisioning` entity.**
      **Create** `packages/agent/src/entities/work-app-provisioning.entity.ts` **(new)** per plan §3.1 (incl.
      `parkedReason`, `parkedAt`, `questionReason`, `questionParams`, `lastRunOutput`), dates via `PortableDateColumn`
      from `packages/agent/src/entities/_types.ts`, scope columns without relations.
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`.
      **Create** `packages/agent/src/database/repositories/work-app-provisioning.repository.ts` **(new)** —
      `findActiveByWork`, `findByTaskId`, `claimLease`, `releaseLease`, `casAttemptsUsed(id, expected)`,
      `countActiveForUser`, `countActiveForOrg`, `listExpiredTargets(limit)`, `listStaleQuestions(limit)`,
      `listQueued(limit)`, `findRecentAgentId(userId, organizationId)`.
      **Test**: `packages/agent/src/entities/__tests__/work-app-provisioning.entity.spec.ts` **(new)** (index names, scope
      columns) and `packages/agent/src/database/repositories/__tests__/work-app-provisioning.repository.spec.ts` **(new)**
      (lease CAS, attempts CAS, active partial-unique behaviour on SQLite so two concurrent inserts yield one row —
      ACC-04-03; a user's 4th active row is counted for queueing — ACC-04-25).
      **Done when**: the database drift specs pass without a magic-number edit.

- [ ] **T8. Migration.**
      **Create** `apps/api/src/migrations/1792040000000-CreateWorkAppProvisionings.ts` **(new)** — table + six indexes,
      including the `questionReason` / `questionParams` / `lastRunOutput` columns of plan §3.1, partial indexes on both
      Postgres and SQLite, `down()` dropping only what `up()` created.
      **Test**: `apps/api/src/migrations/__tests__/CreateWorkAppProvisionings.spec.ts` **(new)** — no statement touches a
      pre-existing table; `up()` then `down()` then `up()` succeeds.
      **Done when**: a fresh database migrates; re-stamped above the newest migration on `develop` at merge time
      (`1791240000000-AddSafetyRailsCore.ts` at `ee45946e5`).

## P1.2 — Guard, schema, prompt, evidence (pure)

- [ ] **T9. Output schema.**
      **Create** `packages/agent/src/app-provisioning/provision-output.schema.ts` **(new)** — strict Zod schema of plan §3.3
      (detection source from `APP_PROVISIONING_DETECTION_SOURCES`) and `extractProvisionOutput(finalMessage)` (last
      fenced `provision-output` block; ≤ 512 KB).
      **Test**: `packages/agent/src/app-provisioning/__tests__/provision-output.schema.spec.ts` **(new)** — last-block
      selection, size cap, strict unknown keys, detection source `auto` accepted and any value outside `APP_PROVISIONING_DETECTION_SOURCES` refused.
      **Done when**: the module has no I/O and `pnpm --filter @ever-works/agent test -- provision-output.schema` passes.

- [ ] **T10. Output guard.**
      **Create** `packages/agent/src/app-provisioning/provision-output.guard.ts` **(new)** — every rule in plan §7.6 with
      stable violation codes (`pathNotWritable`, `tooManyFiles`, `tooManyLines`, `fileTooLarge`, `secretLiteral`,
      `exampleValueReused`, `preservedFieldChanged`, `unpinnedBaseImage`, `missingSmoke`, `missingProbes`,
      `cronWithoutAuth`, `tooManyChecks`, `invalidSpec`, `yamlParse`), using `scanForSecrets` from
      `packages/agent/src/utils/secret-scan.ts` and APW-03's `validateAppSpecDocument`. The `baseSpecYaml` argument is
      the **last valid applied spec** merged with APW-01's `sourceRepository` (plan §3.2) — never the raw head file:
      when the head is absent or invalid the base is `{ source }` plus schema-safe defaults, so an injected pre-seeded
      `upstreamPullRequests.requireApproval: false` is **not** inherited (ACC-NEG-05) while a genuine narrowing of a
      platform-owned field still fails the guard.
      **Test**: `packages/agent/src/app-provisioning/__tests__/provision-output.guard.spec.ts` **(new)** — one case per code;
      an edit outside `.works/works.yml` / `.works/overlay/**` is rejected naming the path (ACC-04-07); a literal secret
      or example-file value rejected naming the variable only (ACC-04-08); a changed source, Blueprint, license or
      upstream field rejected (ACC-04-09); a cron route without auth rejected (ACC-04-14, guard half); an injected
      `AGENTS.md` output that writes outside `.works/` rejected (ACC-04-34, guard half); a hostile pre-seeded head spec
      with `upstreamPullRequests.requireApproval: false` is refused by the guard when the proposal keeps it and passes
      when the proposal drops it; a property check that no
      violation object contains any file content substring longer than 8 characters.
      **Done when**: the guard is pure (no DI, no I/O) and 100% of codes are covered.

- [ ] **T11 (parallel). Prompt builder.**
      **Create** `packages/agent/src/app-provisioning/app-provision-prompt.builder.ts` **(new)** — plan §7.5 order;
      the Task brief carries `buildStrategies` from the App Work's build plugin (R-13) and never a builder name; fences
      reuse the delimiter + neutralisation approach in `packages/agent/src/services/memory-recall.ts`; instruction
      files truncated at 32 KB each, ≤ 8 files; evidence truncated at 200 lines / 16 KB after `redactSecrets`.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-prompt.builder.spec.ts` **(new)** — a fixture
      `AGENTS.md` containing a closing-fence sequence, "ignore previous instructions", "print the environment" and an
      external URL stays inside its `UNTRUSTED PROJECT INSTRUCTIONS` fence (ACC-04-34); the brief lists `auto` only when
      the build plugin double supports it and contains no builder name (ACC-04-38).
      **Done when**: the builder is pure and `pnpm --filter @ever-works/agent test -- app-provision-prompt.builder` passes.

- [ ] **T12 (parallel). Evidence renderer.**
      **Create** `packages/agent/src/app-provisioning/app-provision-evidence.renderer.ts` **(new)** — PR comment Markdown
      from an `AppProvisioningAttempt` + spend + `appProvisionCopy.evidence.*` (T49, English); `redactSecrets`;
      60,000-char cap.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-evidence.renderer.spec.ts` **(new)** — a green
      attempt renders build log link, image digest, target kind, smoke table and spend with no env value (ACC-04-16); a
      runner-target attempt says "Verified in the build runner" (ACC-04-22); truncation at 60,000.
      **Done when**: the renderer is pure and its output passes `scanForSecrets` for every fixture.

## P1.3 — Agent, Skill, sandbox, tools

- [ ] **T13. Agent resolver.**
      **Create** `packages/agent/src/app-provisioning/app-provisioner-agent.resolver.ts` **(new)** — reuse
      `findRecentAgentId(userId, scope)` or `createFromRepoTemplate('app-provisioner')` (T2); install `provision-app` with
      `SkillsService.installFromCatalog` and bind it (`injectIntoAgent: true`, priority 10); write the **allow list** of
      plan §7.4 (`ask_human`, `appProvisionReport`, `appSpecValidateDraft`) **and** the deny list (incl. `commitToRepo`,
      `openPullRequest` — R-17 — plus `transitionTask`, `createTask`, `commentOnTask`, `resolve_escalation`) through
      `packages/agent/src/policy/tool-grant.service.ts`; set `canCallExternalTools: false`; `assertReady(agentId)`
      re-checks skill binding and grants before every dispatch and re-installs the Skill once.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioner-agent.resolver.spec.ts` **(new)** — create
      once, reuse; the deny list includes both git tools (ACC-04-37, grant half); a resolved tool set that contains
      anything outside the allow list refuses dispatch (ACC-04-43); `transitionTask` is refused by grant and withheld by
      the run context (T55); widened grants refuse dispatch; skill re-install once.
      **Done when**: `pnpm --filter @ever-works/agent test -- app-provisioner-agent.resolver` passes.

- [ ] **T14. Sandbox environment + pipeline selection.**
      **Create** `packages/agent/src/app-provisioning/app-provision-sandbox.ts` **(new)** — the pre-resolved
      `runtimeEnvironment` (plan §7.3 host list as a frozen constant), the `attachedRepos` builder (one entry,
      `mountDir: 'repo'`, tokenless, **public repositories only**: a private copy or a linked `private`/`internal`
      repository yields no mount and readiness `publicRepository: false`, plan §2.2 / FR-63), and
      `resolveIsolatedPipeline()` (no `agentId` — no Agent carries a pipeline binding) requiring the flag **and**
      `runSandboxSession` **and** resolvable plugin settings for the user and Work.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-sandbox.spec.ts` **(new)** — host list has no
      IP literal and no internal suffix and excludes the platform origin (ACC-04-05, unit half); the environment carries
      no env files, no credential and one tokenless repository mount (ACC-04-06, unit half); readiness false when no
      pipeline has the flag **or** has the flag without the runner method, so no Run, Task or pull request is created
      (ACC-04-04); a private copy and a private link each give readiness `publicRepository: false`, build no mount, and
      record **zero** calls to `GitFacadeService.getInstallationTokenForOwner` and `getAccessToken` (ACC-04-40).
      **Done when**: the host list is a frozen constant asserted by snapshot.

- [ ] **T15. Provisioning tools.**
      **Create** `packages/agent/src/app-provisioning/app-provision-tools.ts` **(new)** — `appProvisionReport`
      (≤ 280 chars, 1 / minute, writes the analysis step note) and `appSpecValidateDraft` (≤ 128 KB, APW-03 validator,
      returns messages only).
      **Modify** `packages/agent/src/agents/agent-tool.service.ts` — register both only when the run's Task has a
      provisioning row (lookup port from T3).
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-tools.spec.ts` **(new)** — absent for other
      Tasks; rate limit; size cap; `packages/agent/src/agents/__tests__/agent-tool.service.spec.ts` passes unchanged.
      **Done when**: the two tools appear only in provisioning runs' tool lists.
      **Also registered, unchanged, for the sandbox path**: the restricted session of plan §2.6 exposes no platform tool
      at all, so questions reach the job through the `question` outcome of the output contract and validation stays in
      the job (guard + validate step). These two tools stay registered exactly as above — the in-host paths keep using
      them, and nothing is removed from them.

## P1.4 — Writer, pull request, service, job

- [ ] **T16. Writer and PR variants (Task finalize — R-17).**
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — add `pushProvisioningChanges` and
      `openProvisioningPullRequest` (plan §7.6) on the Task finalize path (`WorkspaceFacadeService.finalize`,
      `openPullRequestForBranch`); add optional `transitionToReview` / `attemptAgentMerge` args (default `true`) to the
      private `openPullRequestForBranch`.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-workspace.provisioning.spec.ts` **(new)** — push-only;
      PR without transition or merge attempt; conflict → one rebase; a rejected write pushes nothing (ACC-04-07, writer
      half); existing `finalizeRun` golden calls unchanged.
      **Done when**: existing task-workspace specs under `packages/agent/src/tasks-domain/__tests__/` pass unchanged.

- [ ] **T17. Dispatcher.**
      **Create** `packages/agent/src/tasks/app-provision-dispatcher.ts` **(new)** (plan §6.1).
      **Modify** `packages/agent/src/tasks/_tasks-symbols.ts` (add to `TASKS_BARREL_RUNTIME_SYMBOLS`, alphabetical) and
      `packages/agent/src/tasks/index.ts`.
      **Test**: extend `packages/agent/src/tasks/tasks.spec.ts` — the symbol is `Symbol(...)` and listed.
      **Done when**: `pnpm --filter @ever-works/agent test -- tasks.spec` passes.

- [ ] **T18. Step runner.**
      **Create** `packages/agent/src/app-provisioning/app-provisioning-step-runner.ts` **(new)** — `advance(row, event) → { patch, effects }` over plan §2.5 — including its **outcome table** (`no-change` → `succeeded` with no pull request and a verify-mode build of the base head; `not-runnable` → `failed/not-runnable`; `question` → `needs_input` with a reason; `blocked` → `needs_input/missing-required-value`; parked → a wait) and its **reason → options → row-patch table** — with attempt CAS, fingerprinting (normalisation from
      `packages/agent/src/agents/loop-detector.ts`), infra retries (3 in 30 min), caps (§6.4, incl. the build reservation
      and its `cancelBuild` at `startedAt + reservation`), question reasons, ceilings
      (3 questions, 9 attempts), deadline (8 h active), target selection (runner only in P1), the §4 start-semantics
      outcome for a non-restart start, the Task `prState` precedence of plan §6.2, and the R-17 outcome map of
      plan §6.2 (waits vs `needs_input`).
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning-step-runner.spec.ts` **(new)** — table test
      covering every step × event **and** every outcome of the §2.5 outcome table with its status, step and effect, plus
      one case per reason → options row (option count ≤ 4, `verify-on-cluster` absent in P1) and one per option → row
      patch; plus named cases: a red attempt resumes the Agent with counters that agree
      (ACC-04-17); a repeated fingerprint asks without spending an attempt (ACC-04-18); 3 reds → one question with ≤ 4
      options, an answer grants 2, no 4th question, no 10th attempt (ACC-04-19); infra failures leave the counter and
      fail after 3 retries in 30 min (ACC-04-20); target None boots and smokes in the runner (ACC-04-22); token and
      runner-minute caps refuse dispatch and ask with receipts — used 151 with a reservation of 90 is refused, used 150
      is allowed (ACC-04-24); closing the PR cancels and merging
      mid-attempt ends merged-unverified (ACC-04-29); a job woken by any event while the Task's `prState` is `closed`
      ends `cancelled`; a hostile pre-seeded head spec (invalid, `upstreamPullRequests.requireApproval: false`) yields a
      proposal that does not inherit it (ACC-NEG-05); parked `kill-switch` / `agent-paused` / `workspace-paused` /
      `scope-paused` runs leave `attemptsUsed`, infra retries and `activeMs` unchanged and resume on lift (ACC-04-35);
      every other safety `reasonCode` ends in `needs_input` with reason `safety-rail`, never red (ACC-04-36).
      **Done when**: the runner has no I/O and every effect carries an idempotency key.

- [ ] **T19. Service.**
      **Create** `packages/agent/src/app-provisioning/app-provisioning.service.ts` **(new)** — `start`, `cancel`,
      `notify`, `readiness`, `get` (active + 10 recent), effect executors (Task via
      `packages/agent/src/tasks-domain/tasks.service.ts`, run dispatch through the existing assign-task path, build via the
      APW-05 facade, comments via `GitFacadeService.createPullRequestComment`, Activity via
      `packages/agent/src/activity-log/activity-log.service.ts`, questions per plan §7.7 via
      `packages/agent/src/inbox/inbox.service.ts`, resume via `packages/agent/src/agents/run-steering.service.ts`,
      receipts via `packages/agent/src/agents/run-receipt.service.ts`, push + PR via T16's Task finalize variants);
      per-user 3 / per-org 10 queueing; stop-flag check via `packages/agent/src/agents/run-kill-switch.ts`.
      **Coordinate (safety rails, R-17)**: the assign-task dispatch already passes
      `packages/agent/src/agents/run-admission-chain.ts` (stop flag → AW-23 Agent brake → concurrency → credits) and
      tool calls pass `SAFETY_GATE` (`packages/agent/src/safety/safety-gate.port.ts`); read the parked `queuedReason`
      (`QUEUED_REASON_KILL_SWITCH`, `QUEUED_REASON_AGENT_PAUSED`) and the gate's `reasonCode` into `parkedReason` /
      `parkedAt` or a `safety-rail` question per plan §6.2. Do not re-implement the brake.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_PROVISION = 'app_provision'` to
      `ActivityActionType`; every Activity row uses it as `actionType` with the dotted `app.provision.*` name as `action`
      (R-2).
      **Create** `packages/agent/src/app-provisioning/app-provisioning.module.ts` and
      `packages/agent/src/app-provisioning/index.ts` **(new)**; implement the lookup port (T3) and
      `APP_PROVISION_EVENTS_PORT` (plan §6.5) — all five methods, including `pullRequestStateChanged(taskId, prState)`
      (T52's producer calls it); clear `lastRunOutput` once the guard has read it (plan §2.6).
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_PROVISION = 'app_provision'` to
      `ActivityActionType`; every Activity row uses it as `actionType` with the dotted `app.provision.*` name as `action`
      (R-2). `app.provision.failed` is logged with `ActivityStatus.FAILED` and every other `app.provision.*` row with
      `ActivityStatus.COMPLETED`; `packages/agent/src/activity-log/feed-kind.ts` gains
      `[ActivityActionType.APP_PROVISION]: 'work'` in a commented "App Works (APW-04)" block (T56).
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` **(new)** — start dedupe,
      restart cancels; the **whole §4 start-semantics order** (plan §4): dedupe inside `startDedupeMs` returns the
      existing row with `deduplicated: true` whatever `restart` said and cancels nothing, a 409 only outside the window,
      an automatic trigger on an active row is a no-op, an insert that loses
      `uq_work_app_provisionings_active` returns the winner, readiness false with `restart: true` cancels nothing and
      writes nothing, and a queued promotion whose `isolatedRuntime` is false fails with `no-isolated-runtime` and
      dispatches no Run (ACC-04-41); a user's 4th provisioning is Queued and never more than one active Run or Build
      (ACC-04-25); `pullRequestStateChanged` dispatches `pr-state` exactly once for a `needs_input` or `succeeded` row
      and is a no-op for a terminal row (ACC-04-29);
      Activity holds `started`, `proposed`, `attempted`, `needs_input`, `succeeded`, `failed` with `actionType 'app_provision'` and no body text or values (ACC-04-27, P1 types); a stop-flag or pause park is a wait
      (ACC-04-35) and a gate refusal a question (ACC-04-36).
      `packages/agent/src/app-provisioning/__tests__/app-provisioning.finalize-path.spec.ts` **(new)** — with the Agent's
      `publish` rung set to `ask`, the proposal is pushed and its PR opened through `TaskWorkspaceService` with no held
      action created, and `commitToRepo` / `openPullRequest` are refused for the run (ACC-04-37).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-provisioning.service app-provisioning.finalize-path` passes.

- [ ] **T20. Inbox answer hook.**
      **Modify** `packages/agent/src/inbox/inbox.service.ts` — when a replied item id equals a row's `openInboxItemId`,
      call `notify({ event: 'answered', refId: optionId })` in addition to the existing resume routing (the step runner
      decides whether to resume, cancel, raise a cap or switch target).
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — a provisioning question is filed
      with **no** `agentRunId` (plan §7.7), so `routeQuestionReply` neither steers nor resumes the run; the `answered`
      notify is the only route from the Inbox into the provisioning, which is what keeps the caps and the attempt
      ceilings authoritative.
      **Test**: `packages/agent/src/inbox/__tests__/inbox.service.provisioning-answer.spec.ts` **(new)** — a matching reply
      notifies once, dispatches **zero** `steer` and **zero** `resume` calls, and the existing reply behaviour is
      unchanged for items without a row (ACC-04-19, answer half);
      `packages/agent/src/inbox/__tests__/inbox.service.spec.ts` passes unchanged.
      **Done when**: both specs pass.

- [ ] **T21. Jobs.**
      **Create** `packages/tasks/src/tasks/trigger/app-provision.task.ts` **(new)** (lease, `advance`, effects, delayed
      re-dispatch, 10-min `maxDuration`, 2 retries, 5-minute re-tick while parked) and
      `packages/tasks/src/tasks/trigger/app-provision-sweep.task.ts` **(new)** (cron `7,22,37,52 * * * *`, items 2–6 of
      plan §6.3; item 1 arrives in P2).
      **Modify** `packages/tasks/src/tasks/trigger/index.ts`; wire the dispatcher through
      `packages/agent/src/tasks/job-runtime.providers.ts`.
      **Test**: `packages/tasks/src/__tests__/app-provision.task.spec.ts` **(new)** — lost lease exits quietly; effect
      replay idempotent; a parked row re-ticks without advancing (ACC-04-35); a job woken by a `build-updated` tick for
      a row whose Task `prState` is `closed` cancels instead of building. `packages/tasks/src/__tests__/app-provision-sweep.task.spec.ts`
      **(new)** — sweeper caps at 200 rows; the **fallback** path emits `pr-state` for a closed-PR row the port missed
      (ACC-04-29); a queued promotion whose readiness is false fails with `no-isolated-runtime` and dispatches nothing;
      stale questions remind at 72 h and fail at 14 days.
      **Done when**: `pnpm --filter @ever-works/trigger-tasks test -- app-provision` passes and
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` passes after recounting.

- [ ] **T22. Budget-override approval path.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — cap questions offer `raise-cap`;
      selecting it creates an approval proposal of action type `budget_override` through the existing proposal producer
      (`AgentApprovalsService.createProposal`) carrying the discriminator payload
      `{ kind: 'app-provision-cap', provisioningId, capKind: 'token' | 'runner-minute', delta }`
      (`delta` = `1_000_000` tokens or `60` minutes); approval patches the cap and dispatches `answered`.
      **Create** `packages/agent/src/app-provisioning/app-provision-cap-approval.listener.ts` **(new)** — an
      `@OnEvent` listener on `AgentActionProposalDecidedEvent` (the pattern of
      `packages/agent/src/email/email-draft-approval.listener.ts`) that accepts only
      `decidedVia === 'user'` and only `approved`, re-reads the row, applies
      `tokenCap = min(tokenCapMax, tokenCap + 1_000_000)` /
      `runnerMinuteCap = min(runnerMinuteCapMax, max(runnerMinuteCap + 60, runnerMinutesUsed + reservation))`, and
      dispatches `answered`; any other decision leaves the row `needs_input` and records the outcome on the item.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.budget-override.spec.ts` **(new)** —
      guardrails always queue it (risk flag `budget_override`); the payload round-trips and a proposal for another
      action type is ignored; a rejected, expired or system-decided proposal leaves the row `needs_input`; the raise
      always fits one more build reservation and never exceeds `runnerMinuteCapMax` / `tokenCapMax`; the cap
      question carries receipts (ACC-04-24).
      **Done when**: the spec passes and no approval can raise a cap above its maximum.

## P1.5 — API

- [ ] **T23. Controller and DTOs.**
      **Create** `apps/api/src/works/app-provisioning.controller.ts` and `apps/api/src/works/dto/app-provisioning.dto.ts`
      **(new)** — `POST provision`, `GET provisioning`, `POST provision/cancel` (plan §4), throttles, error contract,
      `canEdit`. The GET response is `AppProvisioningResponse` (plan §3.2) — including `latest`,
      `readiness.publicRepository` and `question.inboxItemId` for the recipient only — and the never-returned key list of
      plan §3.2 is enforced by the DTO, not by convention.
      **Modify** `apps/api/src/works/works.module.ts` — register the new controller.
      **Test**: `apps/api/src/works/app-provisioning.controller.spec.ts` **(new)** — 202 in under 2 s without awaiting the
      job and two concurrent starts yield one id (ACC-04-03); a double restart inside the 10 s window yields one id with
      `deduplicated: true` and 409 only outside it; 409/422 codes; cross-scope 404 on every route; a viewer gets **200**
      with `canEdit: false` and a caller without read permission gets 404 (ACC-04-32); the serialised GET body's key set
      equals the view interfaces' key set exactly, with none of the never-returned keys present (plan §3.2).
      **Done when**: the three routes are in the OpenAPI document with their error codes.

- [ ] **T24. Creation hook.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — `start({ workId, trigger: 'auto-create' })` is idempotent per App Work, returns `{ started: false, missing }` without throwing (and writes nothing) when any readiness flag is false, and refuses when APW-03 reports a resolved Blueprint, a valid App
      spec, or the creator declined (`sourceRepository.autoProvision === false` — manual, chat and endpoint starts
      ignore that flag). Coordinate with APW-01: its `AppSourceInitializerService` minimal path calls it when no Blueprint and no valid
      App spec exist, unless the creator declined.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.auto-start.spec.ts` **(new)** — with APW-01's
      creation-service test double: no Blueprint and no App spec → a provisioning within 60 s of readiness with the Task,
      the row and `app.provision.started` (ACC-04-01); a matched Blueprint, a valid App spec or a declined creator → none
      (ACC-04-02); readiness false → no row, no Task, no Run and no throw, and a later manual `POST /provision` returns
      202 (ACC-04-41).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-provisioning.auto-start` passes.

## P1.6 — Web, chat, i18n, telemetry

- [ ] **T25. Card, steps, dialogs.**
      **Create** `apps/web/src/components/works/detail/overview/AppProvisioningCard.tsx`,
      `apps/web/src/components/works/detail/overview/AppProvisioningSteps.tsx`,
      `apps/web/src/components/works/detail/overview/AppReprovisionDialog.tsx` **(new)** and
      `apps/web/src/app/api/works/[id]/provisioning/route.ts` **(new)**.
      **Modify** `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx` (render for `kind === 'app'`),
      `apps/web/src/lib/api/work.ts`, `apps/web/src/app/actions/dashboard/works.ts`.
      **Test**: `apps/web/src/components/works/detail/overview/AppProvisioningCard.unit.spec.tsx`,
      `apps/web/src/components/works/detail/overview/AppReprovisionDialog.unit.spec.tsx` **(new)** — every headline state
      (incl. the private-repository state) and 8 step rows, poll every 5 s only while active and no request once terminal
      (ACC-04-26), the waiting note (ACC-04-35), viewer hides actions (ACC-04-32), every field rendered comes from
      `AppProvisioningResponse` with no extra fetch, the Needs-input headline renders `question.subject.<reason>` from
      `question.reason` + `question.params` **without** an Inbox fetch, **View report** links to the last `runIds` entry
      (or `pullRequest.url` when one exists), and the dialog sends `restart: true` only in the running-provisioning
      variant (and reopens that variant on a 409).
      **Done when**: `pnpm --filter ever-works-web test -- AppProvisioningCard AppReprovisionDialog` passes.

- [ ] **T26. Chat milestones and chat action.**
      **Create** `packages/agent/src/app-provisioning/app-provision-chat.notifier.ts` **(new)** — plan §7.8 via
      `packages/agent/src/conversations/conversation-message.service.ts`, body copy from `appProvisionCopy.chat.*`
      (T49, stored English), ≤ 12 messages.
      **Modify** `apps/web/src/lib/ai/tools/work.tools.ts` — `provisionAppWork` with confirmation; it never sends
      `restart` (plan §4).
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-chat.notifier.spec.ts` **(new)** — milestones
      land in the Work thread, the thread is created when none exists, and a provisioning that would post a 13th message
      posts nothing more (ACC-04-28); `apps/web/src/lib/ai/tools/work.tools.unit.spec.ts` **(new)** — the chat tool
      requires confirmation and its request body carries no `restart` field.
      **Done when**: both specs pass and `chatMessagesPosted` never exceeds 12 in any fixture.

- [ ] **T27. i18n.**
      **Modify** `apps/web/messages/en.json` — the `dashboard.workDetail.appProvisioning` sub-tree of plan §9 (incl. the
      waiting notes, the `safety-rail` question, the two `queuedReason` keys, `headline.privateRepository` /
      `reason.privateRepository`, the `stepNote.note*` keys and the reminder title/body); mirror into the 20 sibling locale files
      `apps/web/messages/{ar,bg,de,es,fr,he,hi,id,it,ja,ko,nl,pl,pt,ru,th,tr,uk,vi,zh}.json`.
      **Create** `apps/web/src/components/works/detail/overview/app-provisioning-messages.unit.spec.ts` **(new)** —
      modelled on `apps/web/src/components/works/meetings/meetings-messages.unit.spec.ts`: ≥ 21 locales discovered; every key the
      card, steps, dialogs, questions, chat milestones and evidence read exists in every locale; camelCase leaves with no
      `.`; every message survives a `createTranslator` round trip; **and** every `question.*`, `chat.*`, `evidence.*`,
      `reason.*` and `queuedReason.*` leaf equals the matching template in `@ever-works/contracts`
      `app-provisioning-copy.ts`, while every value of the four `*_I18N_KEY` maps exists as a leaf in all 21 locales
      (ACC-04-44).
      **Test**: `pnpm --filter ever-works-web test -- app-provisioning-messages` (ACC-04-33, ACC-04-44).
      **Done when**: the spec passes and the message-key lint reports nothing for the sub-tree.

- [ ] **T28. Telemetry.**
      **Create** `packages/monitoring/src/posthog/app-provision-events.ts` **(new)** — the six events of plan §10.1 with a
      forbidden-property list, following `packages/monitoring/src/posthog/kb-events.ts`.
      **Modify** `packages/monitoring/src/posthog/index.ts` (export) and
      `packages/agent/src/app-provisioning/app-provisioning.service.ts` (emit).
      **Test**: `packages/monitoring/src/posthog/__tests__/app-provision-events.spec.ts` **(new)** — no payload contains a
      repository name, path, env name, question or report text; forbidden keys throw.
      **Done when**: `pnpm --filter @ever-works/monitoring test -- app-provision-events` passes.

- [ ] **T29. P1 e2e.**
      **Create** `apps/web/e2e/app-provisioning-card.spec.ts`, `apps/web/e2e/app-provisioning-reprovision.spec.ts`,
      `apps/web/e2e/app-provisioning-needs-input.spec.ts`, `apps/web/e2e/app-provisioning-a11y.spec.ts` **(new)**.
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — wire ACC-04-01…04, 16…20, 22…29, 32…38 under APW-04
      against the APW-13 fixture app.
      **Test**: `pnpm --filter ever-works-web test:e2e -- app-provisioning-card app-provisioning-reprovision app-provisioning-needs-input app-provisioning-a11y`
      — setup state with no isolated sandbox (ACC-04-04); a private-repository App Work shows the private state with no
      actions (ACC-04-40); a red attempt shows matching counters (ACC-04-17); amber →
      My Decisions → answer → running (ACC-04-19); every headline, 8 rows, polling stops when terminal and axe clean
      (ACC-04-26); closed PR → cancelled card (ACC-04-29); viewer sees no actions (ACC-04-32).
      **Done when**: all pass; no existing Work Overview or Inbox spec needed a selector change.

## P1.7 — Catalog repositories

- [ ] **T30. Agent template (`ever-works/agents`).**
      **Create** in `ever-works/agents`: `templates/app-provisioner/.works/agent.yml`, `templates/app-provisioner/SOUL.md`,
      `templates/app-provisioner/skills.yml` from [`agent-template-draft/`](./agent-template-draft/), plus the companion
      files its header comment lists (`templates/app-provisioner/prompts/system.md`,
      `templates/app-provisioner/prompts/tasks/provision-repository.md`,
      `templates/app-provisioner/prompts/tasks/fix-verification.md`,
      `templates/app-provisioner/kb/playbooks/{detection-order,env-classification,bootstrap-risks}.md`,
      `templates/app-provisioner/README.md`, `templates/app-provisioner/icon.svg`) and `eval/app-provisioner.yml`
      (the catalogue entry of T32). **All of those companions are drafted here** under
      [`agent-template-draft/`](./agent-template-draft/) — `prompts/`, `kb/playbooks/`, `README.md`, `icon.svg` and
      `manifest-row.json` — because that repository's `scripts/validate.js` fails when any path a manifest points at is
      missing, and `SOUL.md` plus the kb seed path must exist too.
      **Modify** `manifest.json` in `ever-works/agents` — a `templates[]` row, copied from the drafted
      [`agent-template-draft/manifest-row.json`](./agent-template-draft/manifest-row.json) (`slug`, `path`, `name`,
      `title`, `summary`, `scope`, `avatarIcon`, `tags`, `manifestPath`, `soulPath`, `readmePath`, `systemPromptPath`,
      `skillsPath`, `kbPath`, `iconPath`, `evalPath`).
      **Branch**: the catalog pull request targets that repository's **default branch** (`main`); if its contributing
      guide names a different integration branch at merge time, use that branch and record it in the task's PR
      description — never push directly to `main`.
      **⚠️ Read this before writing the row: the manifest is what the platform reads, and the files are new.**
      Verified in source: the catalog service fetches **`manifest.json` only**
      (`apps/api/src/agents/agent-template-catalog.service.ts:50-51,191-212`) and maps a row of exactly
      `{ slug, name, title, summary, scope, avatarIcon, tags }` (`:8-16`), while the shipped templates live **in code**
      (`packages/agent/src/agents/agent-templates.ts:62`, read by `agent-templates.service.ts`, written out as
      `SOUL.md`). So the row is what makes `GET /api/agent-templates` list `app-provisioner`, and the `SOUL.md` /
      `agent.yml` / `skills.yml` files are **additive catalog content** that no reader consumes yet — loading them is
      its own work (`EXISTING-SUBSTRATE.md` says so, and APW-04 plan:607 calls it "(new, additive)"). **This task
      must not assume the in-code catalog is replaced**: the two coexist, and the existing templates keep shipping
      from code exactly as they do today.
      **Test**: that repository's schema CI on the pull request (validates `agent.yml` and `skills.yml`), then
      `GET /api/agent-templates` on dev.
      **Done when**: the catalog's schema CI is green and `GET /api/agent-templates` lists `app-provisioner`
      **while the pre-existing templates still list unchanged**.

- [ ] **T31 (parallel). Skill (`ever-works/skills`).**
      **Create** in `ever-works/skills`: `skills/provision-app/SKILL.md` from [`skill-draft/SKILL.md`](./skill-draft/SKILL.md).
      **Modify** `manifest.json` in `ever-works/skills` — a row copied from the drafted
      [`skill-draft/manifest-row.json`](./skill-draft/manifest-row.json): `slug`, `path`, `name`, `summary`, `skillPath`,
      `tags`, `version: 0.1.0`, `license: MIT` **and `sourceUrl`** (the provenance field that repository's
      `schema/skill-manifest.schema.json` requires —
      `https://github.com/ever-works/skills/tree/main/skills/provision-app`).
      **Provenance**: the `ever-works/skills` README seeds every skill from an upstream permissive repository, so a
      first-party skill needs its attribution row there too — draft it beside the manifest row
      ([`skill-draft/README-attribution.md`](./skill-draft/README-attribution.md)) and add it in the same pull request.
      **Test**: extend `packages/plugins/everworks-skills/src/everworks-skills.plugin.spec.ts` with a fixture copy of the
      Skill's frontmatter asserting `allowedTools` parses as the array `['ask_human', 'appProvisionReport', 'appSpecValidateDraft']`.
      **Done when**: the first-party skills provider lists it and its parsed frontmatter carries `allowedTools`.

- [ ] **T32. Skill evals.**
      **Create** `eval/app-provisioner.yml` in `ever-works/agents` from the drafted
      [`eval-draft/app-provisioner.yml`](./eval-draft/app-provisioner.yml) — the eight fixture cases of plan §11.4,
      each referencing its fixture repository and the structured expectation drafted in
      [`eval-draft/expectations.json`](./eval-draft/expectations.json), including the zero-config case run twice: with
      `auto` in the brief (expect detection source `auto`, no overlay Dockerfile) and without it (expect an overlay
      Dockerfile).
      **Create** `packages/agent/src/app-provisioning/__tests__/app-provisioner.eval.spec.ts` **(new)** — the runnable
      half: reads the eight drafted fixture trees under
      [`eval-draft/fixtures/`](./eval-draft/fixtures/) and asserts every expectation of `expectations.json` (detection
      source, dependency set with the citing file, env classifications, jobs, cron, probes, overlay yes/no) as a table
      test, so an eval regression is red in this repository rather than only in a catalog run.
      **Test**: `pnpm --filter @ever-works/agent test -- app-provisioner.eval` plus that repository's schema CI on the
      catalog pull request — detection order across six fixtures
      (ACC-04-10), public-prefix build-time and fixed-length key generator + validation (ACC-04-11), dependency inference
      citing files (ACC-04-12), first-deploy job + negative smoke and pre-deploy migration (ACC-04-13), cron entry with
      auth and none for a descriptor-only route (ACC-04-14), liveness never on a database-touching endpoint (ACC-04-15),
      `auto` vs overlay and no builder named (ACC-04-38).
      **Done when**: every case passes in the monorepo spec and the catalog file validates in the pull request.

- [ ] **T33. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-04-app-provisioner/tasks.md` (tick T6–T32, T46) and the APW-04 row of
      `docs/specs/features/app-works/TRACKER.md`; pin `EVER_WORKS_AGENTS_REF` / the skills catalog ref for the environment.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`; T4's live spec green on the
      nightly lane.
      **Done when**: all commands are green on the P1 merge commit and the nightly isolation run is green.

---

# Phase P2 — Verify on your cluster; upstream breakage (Wave 1)

_Delivers FR-32 cluster branch, FR-51; ACC-04-21, 30 (manual half)._
**Preconditions**: APW-06 P1 (`AppRenderInput.purpose: 'verification'`, `deployApp`, `getAppStatus`, `destroyApp`,
`checkAppCluster`, `app-cluster-op` on the isolated worker, smoke runner — R-10), APW-02 P1 (`app.upstream.synced`
range), APW-07 P1 (in-namespace ephemeral dependencies without PVCs).

- [ ] **T34. Cluster verification target.**
      **Create** `packages/agent/src/app-provisioning/app-provision-verification-target.service.ts` **(new)** — the
      APW-04-side **selector and TTL bookkeeper**: `checkAppCluster`
      probe through `app-cluster-op` (10 s), target choice per plan §2.4, `deployApp({ purpose: 'verification', ttlMinutes: 90 })` with APW-07's ephemeral env mode, pending-on-capacity > 10 min → infra verdict + runner fallback once, TTL tracking and `destroy` on attempt end. It **delegates the namespace lifecycle to APW-06 T60's `AppVerificationTargetService`** (`packages/agent/src/app-runtime/app-verification-target.service.ts`), which owns the `<ns>-v<attempt>` scheme; APW-04 keeps no namespace implementation of its own, so there is exactly one verification-target service and one naming rule on the branch.
      **The verification namespace name comes back from `verification-deploy`, never from here** — APW-06 §9.2 derives
      `<ns>-v<attempt>` from the live namespace and owns it; this service keeps the returned handle and passes it to
      `verification-destroy`. Do **not** compute, prefix or hard-code a name (`ewv-…` was an earlier draft: it would
      have destroyed a namespace APW-06 never created, leaking one per attempt).
      **Modify** `packages/agent/src/app-provisioning/app-provisioning-step-runner.ts` — target selection of plan §2.4.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.verification-target.service.spec.ts` **(new)** with an
      APW-06 plugin double: no Ingress and no PVC in the render input, destroy called on green, red, cancel and TTL
      (ACC-04-21); the namespace value the double returns is the only one ever passed to `verification-destroy`, and no
      name is computed locally; extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.verification-env.spec.ts` (T46)
      with the cluster target (ACC-04-23).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-provision-verification-target app-provisioning.verification-env` passes.

- [ ] **T35. Sweeper item 1.**
      **Modify** `packages/tasks/src/tasks/trigger/app-provision-sweep.task.ts` — expired targets destroyed; three failed
      destroys add the card note.
      **Test**: extend `packages/tasks/src/__tests__/app-provision-sweep.task.spec.ts` — a target past its 90-minute expiry
      is destroyed within one tick and never older than 90 minutes (ACC-04-21); retry cadence every 15 minutes.
      **Done when**: `pnpm --filter @ever-works/trigger-tasks test -- app-provision-sweep` passes.

- [ ] **T36. Upstream breakage banner and range.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — implement
      `smokeFailedAfterUpstreamSync` on the events port; `GET provisioning` returns `upstreamSmokeBroken`; a re-provision
      started from the banner carries `upstreamFromSha` / `upstreamToSha` into the Task brief.
      **Modify** `apps/web/src/components/works/detail/overview/AppProvisioningCard.tsx` for the banner.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` — the banner state
      after a failing first post-sync Deployment and no automatic start without the opt-in (ACC-04-30, manual half);
      extend `apps/web/e2e/app-provisioning-card.spec.ts` with the banner case.
      **Done when**: both specs pass.

- [ ] **T37. P2 e2e and ship gate.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` — extend the APW-04 journey with a cluster-target attempt
      (ACC-04-21); `docs/specs/features/app-works/APW-04-app-provisioner/tasks.md` (tick T34–T36) and the APW-04 row of
      `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`; the nightly
      `apps/web/e2e/flow-app-works-live-provisioner-path.spec.ts` run with target `cluster` (ACC-04-21).
      **Done when**: all commands are green and the nightly evidence names the APW-06-derived `<ns>-v<attempt>`
      verification namespace (the value `verification-deploy` returned — never a locally computed name) gone within
      5 minutes.

---

# Phase P3 — Blueprint suggestions; opt-in automatic re-provision (Wave 2)

_Delivers FR-52…FR-55; ACC-04-30 (automatic half), 31._
**Preconditions**: APW-03 license class on `WorkAppSpecState`; `spec.provisioning.autoReprovision` in the APW-03 schema.

- [ ] **T38. Suggestion endpoint and bundle.**
      **Modify** `apps/api/src/works/app-provisioning.controller.ts` — `POST …/blueprint-suggestion` (consent, eligibility,
      5 / 30 days, one open per upstream).
      **Create** `packages/agent/src/app-provisioning/app-blueprint-suggestion.builder.ts` **(new)** — strips `source`,
      `domains` hosts, generated and prompted values; keeps overlay files, smoke tests, upstream repo + commit, license,
      evidence links; ≤ 256 KB.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-blueprint-suggestion.builder.spec.ts` **(new)** — no
      domain, generated or prompted value survives (ACC-04-31); extend `apps/api/src/works/app-provisioning.controller.spec.ts`
      — 422 when FR-53 fails and 409 for a second suggestion for the same upstream (ACC-04-31); extend
      `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` — `app.provision.blueprint_suggested`
      completes the seven event types (ACC-04-27).
      **Done when**: the three specs pass.

- [ ] **T39. Admin review list.**
      **Create** `apps/api/src/works/admin-app-blueprint-suggestions.controller.ts` **(new)** —
      `@Controller('api/admin/app-blueprint-suggestions')`, platform-admin guard in the style of
      `apps/api/src/budgets/admin-usage.controller.ts`; list ≤ 50 per page; bundle download.
      **Create** `apps/web/src/app/[locale]/(dashboard)/admin/app-blueprint-suggestions/page.tsx` **(new, read-only)** and
      `apps/web/src/components/works/detail/overview/AppBlueprintSuggestDialog.tsx` **(new)**.
      **Modify** `apps/api/src/works/works.module.ts` — register the admin controller.
      **Test**: `apps/api/src/works/admin-app-blueprint-suggestions.controller.spec.ts` **(new)** — non-admin 404;
      `apps/web/e2e/app-provisioning-suggest-blueprint.spec.ts` **(new)** — hidden unless eligible, consent gates submit,
      suggested state (ACC-04-31).
      **Done when**: both specs pass.

- [ ] **T40. Automatic re-provision (opt-in).**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — read `spec.provisioning.autoReprovision`
      through `AppSpecService.getEffectiveSpec`; on `smokeFailedAfterUpstreamSync` start with trigger `auto-upstream-smoke`
      at most 1 per sync commit and 2 per 7 days.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` — both limits; never
      starts when the flag is absent or false (ACC-04-30, automatic half).
      **Done when**: the spec passes.

- [ ] **T41. Per-Organization cap override.**
      **Modify** `packages/agent/src/entities/organization.entity.ts` — nullable simple-json `appProvisionCaps`
      (`{ tokenCap?, runnerMinuteCap? }`); `apps/api/src/organizations/dto/update-organization.dto.ts` — accept it within
      plan §3.2 bounds; `packages/agent/src/app-provisioning/app-provisioning.service.ts` — resolve Organization → instance
      env → default.
      **Create** `apps/api/src/migrations/1792040100000-AddOrganizationAppProvisionCaps.ts` **(new)** — adds the one
      nullable column.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.caps.spec.ts` **(new)** — clamping and the
      resolution order; Activity records field names only; `apps/api/src/migrations/__tests__/AddOrganizationAppProvisionCaps.spec.ts`
      **(new)** — only the new column is added and dropped.
      **Done when**: both specs pass and `packages/agent/src/entities/__tests__/organization.entity.spec.ts` passes.

- [ ] **T42. P3 ship gate.**
      **Modify** `docs/specs/features/app-works/APW-04-app-provisioner/tasks.md` (tick T38–T41) and the APW-04 row of
      `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`; walk ACC-04-30 and
      ACC-04-31 on stage.
      **Done when**: all commands are green and both criteria are ticked in spec §8.

---

# Cross-phase closing tasks

- [ ] **T43. Docs.**
      **Create** `docs/features/app-provisioner.md` **(new)** — what the card states mean (incl. waiting on a stop or pause),
      what the sandbox can and cannot reach, what the evidence proves, caps and how to raise them.
      **Modify** `apps/docs/sidebarsPlatform.ts` to list it. Do not touch `docs/plugin-system/built-in-plugins.md` (no
      plugin added).
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
      **Done when**: the page is reachable from the platform docs sidebar.

- [ ] **T44. Vocabulary.**
      **Modify** `docs/specs/features/app-works/README.md` — add **App provisioning** to §1 of the program (spec §5.2) in the
      same PR as T7 (already present at authoring — confirm the row still matches the shipped entity name).
      **Test**: `rg -n "App provisioning" docs/specs/features/app-works/README.md` shows the §1 row naming
      `WorkAppProvisioning`.
      **Done when**: the README row and the entity name match.

- [ ] **T45. Statuses.**
      **Modify** `docs/specs/features/app-works/APW-04-app-provisioner/spec.md`, `…/plan.md` and this file — set
      `Implemented` / `Done`.
      **Test**: walk every gate in the plan §13 constitution compliance checklist and the "Known gaps" list against the
      merged code.
      **Done when**: statuses read `Implemented` / `Done` and every gate still holds.

- [ ] **T46 (P1, lands with T18–T19). Verification never stores env values.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — every verification request passes
      APW-07's ephemeral `AppRuntimeEnvSource` mode (runner: `startBuild({ mode: 'verify', verification })` with in-memory
      generated and derived values; cluster, from P2: the verification render input) and never calls a `WorkAppEnvValue`
      write path.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provisioning.verification-env.spec.ts` **(new)** — a
      red → green runner journey with a `WorkAppEnvValue` repository spy records zero `save` / `insert` / `update` calls,
      every verification request carries the ephemeral mode, and the stored env of the App Work is byte-identical before
      and after (ACC-04-23).
      **Done when**: `pnpm --filter @ever-works/agent test -- app-provisioning.verification-env` passes.

- [ ] **T47 (P1, lands with T7–T8). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'app-provisionings.jsonl', entity: 'WorkAppProvisioning', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`
      (through the Work, never `by: 'user'`, which would also export runs the person started in other workspaces).
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — add `tokenCap` to `BACKUP_BENIGN_COLUMNS`
      ("a model-token ceiling, not a credential"); `tokensUsed` is already exempt. Nothing joins
      `BACKUP_DROPPED_ENTITIES`. T41's `Organization.appProvisionCaps` needs no entry: `Organization` already exports as
      `data/organizations/organization.jsonl` and the column name is not secret-shaped.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` —
      `WorkAppProvisioning` is referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not
      dropped; `Organization` is still referenced by `organizations/organization.jsonl`.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green — including the
      secret-shaped-column guard in `redaction.spec.ts` — and a backup of a workspace with one provisioning run lists
      `data/works/app-provisionings.jsonl`.

---

# Added by the APW-04 gap audit (2026-09-17)

_Each task names its phase and the tasks it lands with. Nothing above is renumbered or replaced: these are additions._

- [ ] **T48 (P1, lands before T19). Provisioning session runner.**
      **Create** `packages/agent/src/app-provisioning/app-provision-session.runner.ts` **(new)** per plan §2.6 —
      resolves the first enabled pipeline plugin that has `enforcesRuntimeNetworking` **and** `runSandboxSession`
      (T1) plus resolvable settings, opens one restricted session with the Skill body as `system`, the plan §7.5 brief as
      `prompt`, the plan §7.3 environment, one tokenless `attachedRepos` entry, `budgetUsd` from plan §6.4 and
      `timeoutMs` from FR-14; maps the result (`completed` / `failed` / `cancelled` / `timeout` / `budget-exhausted`,
      `failureCode`, `finalText`, `usage`); writes the run's terminal status, tokens and cost, a redacted ≤ 2,000-char
      summary, and `lastRunOutput` (≤ 512 KB, cleared after the guard reads it); notifies `run-finished`.
      **Modify** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` — the T3 branch calls it and never falls
      back to `AgentRunService.execute`; a provisioning Task with no capable plugin is refused before any spend.
      **Test**: `packages/agent/src/app-provisioning/__tests__/app-provision-session.runner.spec.ts` **(new)** — the cases
      listed in plan §11.1, including "no capable plugin → refused with zero run spend" and "no fallback to `execute`"
      (ACC-04-42, ACC-04-04).
      **Done when**: no provisioning run reaches the in-process tool loop (asserted by a spy on
      `AgentRunService.execute`) and the live isolation spec (T4) opens its session through this runner.

- [ ] **T49 (P1, lands with T6–T12). Provisioning copy module and id→key maps.**
      **Create** `packages/contracts/src/apps/app-provisioning-copy.ts` **(new)** — `appProvisionCopy.questionSubject`,
      `.questionOptions`, `.reasonText`, `.queuedReason`, `.chat.*`, `.evidence.*` and `.reminder`, one exported constant
      per string, values character-for-character those of plan §9's `en.json` leaves (spec §6 is the copy of record).
      **Modify** `packages/contracts/src/apps/app-provisioning.ts` — the four `*_I18N_KEY` maps of plan §3.2.
      **Test**: `packages/contracts/src/apps/__tests__/app-provisioning-copy.spec.ts` **(new)** — every reason, option,
      failure and queued id has a map entry matching `/^[a-z][a-zA-Z0-9]*$/`; every template is non-empty; no template
      contains a placeholder that is not a declared param; `choose:<n>` resolves through its prefix.
      **Done when**: the module has no I/O and T27's equality test passes against it.

- [ ] **T50 (P1, lands with T19). Start semantics: dedupe, readiness, restart.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — the seven ordered steps of plan §4
      "Start semantics", in one transaction: dedupe inside `startDedupeMs`, 409 only outside it for manual/chat, no-op for
      automatic triggers on an active row, readiness refusal with nothing written and nothing cancelled, restart
      compare-and-set, queueing reasons, and the lost-unique-insert race returning the winner.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` — the cases named
      in T19 (ACC-04-41, ACC-04-03, ACC-04-25).
      **Done when**: the service spec covers all seven steps and no path can create two active rows for one App Work.

- [ ] **T51 (P1, lands with T16–T19). Provisioning Tasks are excluded from CI auto-resume and the merge gate.**
      **Modify** `packages/agent/src/tasks-domain/task-pr-status.service.ts` — before `offerRedGateToFixLoop`
      (`:319-358`), look the Task up through the provisioning lookup port (T3) and skip the fix-loop offer for a
      provisioning Task; skip `TaskMergeGateService`'s merge attempt and approval raise for the same Tasks
      (`task-merge-gate.service.ts`, called from the poll at `:515`) so FR-9 holds whatever the merge policy says and no
      uncapped resume is started outside the step runner.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-pr-status.provisioning.spec.ts` **(new)** — a red check on a
      provisioning PR creates no auto-resume attempt and no Inbox notice; green CI on a provisioning PR creates no agent
      merge and raises no approval; `task-pr-status.service.spec.ts` and the merge-gate spec pass unchanged (ACC-04-37,
      FR-9).
      **Done when**: the two specs pass and a grep shows no other caller merging a provisioning Task's pull request.

- [ ] **T52 (P1, lands with T16/T21). PR-state producer hook (S17 within 5 minutes).**
      **Modify** `packages/agent/src/tasks-domain/task-pr-status.service.ts` — capture `task.prState` before
      `updatePrStatusCache`; when the new state is `closed` or `merged` and differs, call
      `APP_PROVISION_EVENTS_PORT.pullRequestStateChanged(task.id, state)` fire-and-forget (catch, warn, never fail the
      refresh); inject the port `@Optional() @Inject(APP_PROVISION_EVENTS_PORT)` **last** in the constructor, and
      coordinate with APW-08 T22 (whichever PR lands second appends after the other).
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-pr-status.app-provision.spec.ts` **(new)** — open→closed and
      open→merged each call the port once, on both the sync and the on-demand refresh; no call when the state is
      unchanged or the port is absent; a throwing port does not fail the refresh; `task-pr-status.service.spec.ts` passes
      unchanged (ACC-04-29).
      **Done when**: the spec passes and S17's 5-minute bound is met by the producer plus the §6.3 item 6 fallback.

- [ ] **T53 (P1, lands with T7/T13). Per-person Agent ownership.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioner-agent.resolver.ts` — `resolve({ userId, scope })`
      with `scope = ownershipScopeOf(work)`; never reuse another Organization member's Agent.
      **Modify** `packages/agent/src/database/repositories/work-app-provisioning.repository.ts` —
      `findRecentAgentId(userId, scope)` matches `userId` **and** the exact tenant/organization ids.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioner-agent.resolver.spec.ts` — two
      editors of one Organization each get their own Agent and neither run ends `agent-not-found`; the same person in a
      personal space and in an Organization gets two Agents with no name conflict (ACC-04-39).
      **Done when**: the resolver spec passes and the repository spec asserts the scope predicate.

- [ ] **T54 (P1, lands with T19). Events-port producers and their contract tests.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — implement all five port methods,
      including `buildUpdated(buildId)` and `targetUpdated(workId, namespace)` (both already in the CONTRACTS §3 row) and
      `smokeFailedAfterUpstreamSync(workId, fromSha, toSha)` (T36). Recognize "the first Deployment built from an
      upstream sync commit" from `WorkBuild`'s recorded upstream-sync origin (APW-05/APW-02 field; the APW-05 and APW-06
      task rows that call these producers are reported for their owners, not written here).
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts` — each producer
      moves the row and dispatches the matching event exactly once, an unknown build or namespace is a no-op, and the
      banner state is reachable **through the port** rather than by calling the service directly (ACC-04-30).
      **Done when**: no port method is reachable only from a test double.

- [ ] **T55 (P1, lands with T13). Tool allow list and the withheld virtual transition.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioner-agent.resolver.ts` — write the Agent-scope
      `allow: ['ask_human', 'appProvisionReport', 'appSpecValidateDraft']` row **and** the extended deny list
      (`transitionTask`, `createTask`, `commentOnTask`, `resolve_escalation` added) through `ToolGrantService.upsert`.
      **Modify** `packages/agent/src/agents/agent-run.service.ts` — add the optional
      `AgentRunContext.withholdVirtualTransition?: boolean` and skip the virtual `transitionTask` descriptor
      (`:852-870`, descriptor at `:1365`) when it is set; the T3 branch dispatches with it. Every other run is unchanged.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioner-agent.resolver.spec.ts` — the grant
      row's allow list is exactly those three names; `transitionTask`, `createTask`, `commentOnTask`, `resolve_escalation`
      and a sample tool outside the list are all refused; with the flag unset the descriptor is still offered to every
      other run (ACC-04-43, ACC-04-37).
      **Done when**: both specs pass and `agent-run.service.spec.ts` passes unchanged.

- [ ] **T56 (P1, lands with T19). Activity feed-kind and the pinned enum count.**
      **Modify** `packages/agent/src/activity-log/feed-kind.ts` — add
      `[ActivityActionType.APP_PROVISION]: 'work'` in a commented "App Works (APW-04)" block.
      **Modify** `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` — add the `['APP_PROVISION',
'app_provision']` pair to `cases` and recount the pinned `toHaveLength(...)` (`:410`) to the merged enum (200 on
      `develop` @ `873274c9f`, plus every member APW-01/03/05/07 add before this lands), with the recount recorded in the
      comment.
      **Test**: `pnpm --filter @ever-works/agent test -- feed-kind activity-log.types` — every `ActivityActionType`
      member resolves to a feed kind, `app_provision` is `work`, and a `failed` row is a `problem`
      (`FEED_PROBLEM_STATUSES`, `feed-kind.ts:35-38`) (ACC-04-27).
      **Done when**: both specs pass without a magic-number edit elsewhere; no change is needed in
      `packages/agent/src/shared-views/publishable-activity.ts` (`NEVER_PUBLISH_ACTIVITY_ACTIONS` is derived, `:28-32`).

- [ ] **T57 (P1, lands with T10/T18). Guard base spec for an invalid pre-seeded spec.**
      **Modify** `packages/agent/src/app-provisioning/provision-output.guard.ts` and
      `packages/agent/src/app-provisioning/app-provisioning-step-runner.ts` — the base for `preservedFieldChanged` is the
      last valid applied spec merged with APW-01's `sourceRepository` (plan §3.2); with an absent or invalid head the base
      is `{ source }` plus schema-safe defaults (`upstreamPullRequests.requireApproval: true`,
      `display.protectedPaths` from the Blueprint or empty, `provisioning.autoReprovision: false`).
      **Test**: extend the T10 guard spec and the T18 step-runner spec — the injection fixture's pre-seeded
      `upstreamPullRequests.requireApproval: false` is not inherited (ACC-NEG-05), the proposal that drops it passes, and
      a genuine narrowing of a platform-owned field still fails `preservedFieldChanged` (ACC-04-09).
      **Done when**: both specs pass and ACC-NEG-05's e2e lane stays green.

- [ ] **T58 (P1, lands with T24). Declined automatic start.**
      **Modify** `packages/agent/src/app-provisioning/app-provisioning.service.ts` — `start({ trigger: 'auto-create' })`
      is a no-op (no row, no Task, no `app.provision.started`) when `sourceRepository.autoProvision === false`; manual,
      chat and endpoint starts ignore the flag.
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provisioning.auto-start.spec.ts` — a declined
      creation provisions nothing, the card is Not started, and a later manual `POST /provision` returns 202 (ACC-04-02,
      ACC-04-01).
      **Done when**: the spec passes and APW-01's `sourceRepository.autoProvision` field is read (never re-derived).

- [ ] **T59 (P1, lands with T14). Private data repository refusal.**
      **Modify** `packages/agent/src/app-provisioning/app-provision-sandbox.ts` and
      `packages/agent/src/app-provisioning/app-provisioning.service.ts` — readiness gains `publicRepository` (read from
      APW-02's `IGitProviderPlugin.getRepository` visibility); a private copy or a `private`/`internal` link builds no
      mount, mints no token, writes no row, and shows the private-repository state (spec §6).
      **Test**: extend `packages/agent/src/app-provisioning/__tests__/app-provision-sandbox.spec.ts` and the controller
      spec — a private copy and a private link each give readiness `publicRepository: false`, `422 provisioningUnavailable`
      with `missing: ['publicRepository']`, zero Run/Task/PR and zero mint calls (ACC-04-40).
      **Done when**: both specs pass and no code path calls `GitFacadeService.getInstallationTokenForOwner` for a
      provisioning mount.

- [ ] **T60 (P1, lands with T30–T32). Catalog drafts: agent template companions, manifest rows and the eval package.**
      **Create** under [`agent-template-draft/`](./agent-template-draft/): `prompts/system.md`,
      `prompts/tasks/provision-repository.md`, `prompts/tasks/fix-verification.md`,
      `kb/playbooks/detection-order.md`, `kb/playbooks/env-classification.md`, `kb/playbooks/bootstrap-risks.md`,
      `README.md`, `icon.svg` and `manifest-row.json` — every path the drafted `.works/agent.yml` points at, so
      `ever-works/agents`' `scripts/validate.js` can pass on the pull request.
      **Create** [`skill-draft/manifest-row.json`](./skill-draft/manifest-row.json) (incl. `sourceUrl`) and
      [`skill-draft/README-attribution.md`](./skill-draft/README-attribution.md).
      **Create** under [`eval-draft/`](./eval-draft/): `app-provisioner.yml`, `expectations.json` and
      `fixtures/<case>/tree.md` for the eight cases of plan §11.4.
      **Test**: the drafts are consumed by T30, T31 and T32 — this task's own check is that every path referenced by
      `agent-template-draft/.works/agent.yml`, by `manifest-row.json` and by `eval-draft/app-provisioner.yml` exists in
      this folder (`rg` over the drafts, asserted by the T30/T32 review checklist since the catalog repository is outside
      this monorepo).
      **Done when**: T30, T31 and T32 can be executed from these drafts without inventing a file.

---

## Definition of Done

- Every checkbox above is ticked for the phases being shipped.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the repo root.
- The sandbox isolation live spec (T4) is green on the nightly lane **and** its unrestricted control was shown to reach
  the unlisted host.
- `packages/tasks/src/__tests__/agent-task-execute.task.spec.ts`,
  `packages/agent/src/agents/__tests__/agent-templates.service.spec.ts` and the task-workspace specs pass unchanged.
- Every ACC-04 criterion in [spec §8](./spec.md) (ACC-04-01…ACC-04-44) for the shipped phases has a named test above or a
  walked acceptance step.
- No secret value appears in any fixture, snapshot, log assertion, Activity row, telemetry payload or PR comment test.
- No test file lives under `apps/api/test/`; every shared contract lives in `packages/contracts/src/apps/` (R-1); no proposal or
  brief names a builder for `auto`.
