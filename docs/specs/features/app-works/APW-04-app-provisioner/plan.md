# Implementation Plan: App Provisioner

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail; the
> spec owns behaviour. **Every existing path below was opened in the worktree before it was written down**; paths
> marked **(new)** are created by this epic. Names shared with other epics come from
> [`CONTRACTS.md`](../CONTRACTS.md) and are not re-declared here.

**Epic ID**: `APW-04-app-provisioner`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Drafts**: [`skill-draft/SKILL.md`](./skill-draft/SKILL.md) · [`agent-template-draft/`](./agent-template-draft/)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Authored against**: `develop` @ `a655b53ca` · **Re-aligned**: `develop` @ `ee45946e5` with
[CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding--2026-09-17-against-develop--ee45946e5)

> **Program audit resolutions applied (binding).** R-1 — contracts live in `packages/contracts/src/apps/` (§3.2), never
> a `src/app-works/` folder. R-2 — Activity rows carry the dotted §6 name in `action` and `actionType: 'app_provision'`
> (§6.5). R-10 — APW-05 `startBuild({ verification })`, APW-06 `AppRenderInput.purpose: 'verification'` and APW-07's
> ephemeral `AppRuntimeEnvSource` mode are **accepted** and implemented by their owners' tasks; this epic only consumes
> them (§8). R-13 — detection step 6 proposes `build.strategy: auto` when the App Work's build plugin supports it, never
> naming a builder (§7.5). R-17 — parked runs are waits, a safety-gate refusal becomes `needs_input`, and the proposal's
> push and pull request go through Task finalize, not the agent git tools (§6.2, §7.6). R-22 — no suite under
> `apps/api/test/`; the isolation check moved to a runnable root (§11.3).

---

## 1. Current state in the codebase

### 1.1 What ships today and is reused

| Layer          | File                                                                                                                                                                                                                                     | What it does, as far as this epic cares                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker         | `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts`                                                                                                                                                                            | The Task run: resolves checks → `TaskWorkspaceService.provisionForRun` → optional L0 pre-check → pipeline run → red→iterate gate loop bounded by `resolveMaxGateAttempts` → `finalizeRun`. **The gate runs before the push.**                                                                                                                                                                                                                                                                                                                                                        |
| Task workspace | `packages/agent/src/tasks-domain/task-workspace.service.ts`                                                                                                                                                                              | `provisionForRun` (data repo via `work.getDataRepo()`, branch `task/<slug>`, token from `GitFacadeService.getAccessToken`), `finalizeRun` (commit, push, `simulateMerge`, then the private `openPullRequestForBranch`, which transitions the Task to `in_review` and consults merge policy). Comment: "a red gate never reaches finalizeRun at all".                                                                                                                                                                                                                                 |
| Facade         | `packages/agent/src/facades/workspace.facade.ts`                                                                                                                                                                                         | `provision` / `finalize` / `simulateMerge` / `teardown` over the `workspace` capability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Plugin         | `packages/plugins/sandbox-workspace/src/sandbox-workspace.plugin.ts`                                                                                                                                                                     | Shallow clone (`fetchDepth` 1), token-free `origin`, token injected per command. The git child process inherits the worker environment and has **no network policy** — acceptable for a writer checkout that runs only git, not for analysis.                                                                                                                                                                                                                                                                                                                                        |
| Gates          | `packages/agent/src/tasks-domain/task-gates.ts`                                                                                                                                                                                          | `MIN_GATE_ATTEMPTS = 1`, `MAX_GATE_ATTEMPTS = 5`, `DEFAULT_GATE_ATTEMPTS = 2`; `resolveGateVerdict` (`pass`/`retry`/`fail`/`escalate`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Gates          | `packages/agent/src/tasks-domain/task-gate-runner.service.ts`                                                                                                                                                                            | Spawns each `TaskAcceptanceCheck.command` in the checkout; persists `gateStatus`/`checkResults`/`gateAttempts` on the run. Commands only.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Contract       | `packages/contracts/src/tasks/task-gates.types.ts`                                                                                                                                                                                       | `TaskAcceptanceCheck` is command-shaped (`kind`, `command`, `phase` setup/check, `level` L0/L1). No platform-evaluated check kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Post-PR loop   | `packages/agent/src/database/repositories/task-ci-auto-resume-attempt.repository.ts`, `docs/features/ci-auto-resume.md`                                                                                                                  | CI red on an open PR resumes the run under a durable budget: attempt row claimed per `(task, head sha)` before dispatch, failure fingerprint, one Inbox notice when spent. **The shape this epic's verify→resume loop copies.**                                                                                                                                                                                                                                                                                                                                                      |
| Loop detection | `packages/agent/src/agents/loop-detector.ts`                                                                                                                                                                                             | Normalised failure fingerprints; `repeated-failure` signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Ask-human      | `packages/agent/src/inbox/agent-inbox-tools.ts`, `packages/agent/src/inbox/inbox.service.ts`                                                                                                                                             | `ask_human` tool (question, ≤ n options, context) → `InboxService.askHuman` writes a `question` item and parks the run (`awaitingInput`); a reply steers or resumes. `questionRaised` / `escalationRaised` producers.                                                                                                                                                                                                                                                                                                                                                                |
| My Decisions   | `apps/web/src/components/inbox/InboxDecisionsClient.tsx`                                                                                                                                                                                 | The Inbox as a ranked decision queue at `/inbox?view=decisions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Resume         | `packages/agent/src/agents/run-steering.service.ts`                                                                                                                                                                                      | `steer`, `interrupt`, `resumeRun` / `resume` (new run carrying the session id).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Escalations    | `packages/agent/src/agents/agent-escalation.service.ts`                                                                                                                                                                                  | `record` with reason codes incl. `gate-exhausted`, `budget-stop`, `awaiting-input`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Environments   | `packages/agent/src/environments/environments.service.ts`, `docs/features/environments.md`                                                                                                                                               | Agent sandbox package + networking settings; `resolveRuntimeEnvironmentForAgent`. **Limited networking is enforced only by the `claude-managed-agent` pipeline**; every other pipeline treats it as advisory.                                                                                                                                                                                                                                                                                                                                                                        |
| Pipeline       | `packages/plugin/src/contracts/capabilities/pipeline-plugin.interface.ts`                                                                                                                                                                | Run options carry `agentId`, a pre-resolved `runtimeEnvironment` (wins over agent resolution) and `attachedRepos` (`url`, `branch`, `mountDir`).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pipeline       | `packages/plugins/claude-managed-agent/src/utils/runtime-environment.ts`                                                                                                                                                                 | Maps `networkingMode: limited` + `allowedHosts` + `allowPackageManagers` to the sandbox policy; pins `allow_mcp_servers: false`. Per-session USD budget cap exists in plugin settings.                                                                                                                                                                                                                                                                                                                                                                                               |
| Tool policy    | `packages/agent/src/policy/tool-grant.service.ts`, `tool-grant.enforcer.ts`                                                                                                                                                              | Per-Agent allow/deny matrix; `deny` is additive and permanent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tools          | `packages/agent/src/agents/agent-tool.service.ts`                                                                                                                                                                                        | `commitToRepo`, `openPullRequest`, `searchWeb`, `extractContent`, `sendEmail`, `messageAgent`, `notifyChannel`, `delegateToAgent`, `createSubAgent`, `editAgentFile`, `screenshot`, … (the git pair is reported broken in EXISTING-SUBSTRATE; this epic denies both).                                                                                                                                                                                                                                                                                                                |
| Templates      | `packages/agent/src/agents/agent-templates.service.ts`                                                                                                                                                                                   | `createFromTemplate` instantiates **in-code** `AGENT_TEMPLATES` only (`agent-templates.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Templates      | `apps/api/src/agents/agent-template-catalog.service.ts`                                                                                                                                                                                  | Lists `ever-works/agents` `manifest.json` rows (slug, title, summary, tags). **List-only**; ref `EVER_WORKS_AGENTS_REF`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Skills         | `packages/agent/src/skills/skills.service.ts`, `packages/plugins/everworks-skills/src/everworks-skills.plugin.ts`                                                                                                                        | `installFromCatalog`, binding CRUD, body screening (`assertNoSecrets`, injection tokens). The provider parses `SKILL.md` frontmatter preserving extra keys.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Skills         | `packages/agent/src/policy/skill-activation.ts`                                                                                                                                                                                          | Reads `frontmatter.allowedTools` (camelCase **array**); the agentskills `allowed-tools` string is not read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Git            | `packages/agent/src/facades/git.facade.ts`                                                                                                                                                                                               | `createPullRequest`, `getPullRequest`, `createPullRequestComment`, `closePullRequest`, `getInstallationTokenForOwner`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Git contract   | `packages/plugin/src/contracts/capabilities/git-provider.interface.ts`                                                                                                                                                                   | `CreatePROptions.draft?`; no "ready for review" operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PR status      | `packages/agent/src/tasks-domain/task-pr-status.service.ts`                                                                                                                                                                              | The two-minute poll that writes `prState`/`ciState` on Tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Works config   | `packages/agent/src/works-config/schema/works-config.schema.ts`                                                                                                                                                                          | `KIND_SPEC_SCHEMAS` (no `app` until APW-03), `validateWorksConfig`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Chat           | `packages/agent/src/conversations/conversation-message.service.ts`, `packages/agent/src/entities/conversation.entity.ts`                                                                                                                 | `appendAgentMessage` (redacts secrets); conversations carry `contextType: 'work'` + `contextId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Task chat      | `packages/agent/src/tasks-domain/task-chat.service.ts`                                                                                                                                                                                   | Task thread `post`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Activity       | `packages/agent/src/activity-log/activity-log.service.ts`                                                                                                                                                                                | `log(entry)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Receipts       | `packages/agent/src/agents/run-receipt.service.ts`                                                                                                                                                                                       | `getReceipt` — per-run cost projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secrets        | `packages/agent/src/utils/secret-scan.ts`                                                                                                                                                                                                | `scanForSecrets`, `redactSecrets`, `assertNoSecrets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Fencing        | `packages/agent/src/services/memory-recall.ts`                                                                                                                                                                                           | The delimited-untrusted-block pattern for text reaching a model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Stop flag      | `packages/agent/src/agents/run-kill-switch.ts`                                                                                                                                                                                           | Global stop; fail-closed reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Run admission  | `packages/agent/src/agents/run-admission-chain.ts`, `packages/agent/src/agents/run-dispatch-gate.service.ts`, `packages/agent/src/agents/agent-brake.service.ts` (AW-23, added after authoring)                                          | `DEFAULT_RUN_ADMISSION_CHAIN`: stop flag (parks `kill-switch`) → Agent brake (parks `agent-paused` while the Agent is paused or archived) → Work → organization → credits. Every run dispatched through the assign-task path passes it.                                                                                                                                                                                                                                                                                                                                              |
| Safety rails   | `packages/agent/src/safety/action-category.ts`, `packages/agent/src/safety/safety-gate.port.ts` (AW-24 P1, added after authoring)                                                                                                        | Every tool call passes `SAFETY_GATE` (platform stop, workspace pause, caps, trust ladder). `commitToRepo` / `openPullRequest` / `facade:deploy` are `publish.external`; `facade:terminal-session` is `machine.run` (default rung `ask`, enforced only for explicit rungs until AW-24 P2). Rails run in `SAFETY_RAIL_ORDER` (`packages/contracts/src/safety/safety-rail.types.ts`): `platform-stop`, `workspace-pause` (`packages/agent/src/safety/rails/workspace-pause.rail.ts`), `scope-pause`, `grants`, `ladder`, `caps`, `rules`; verdict `reasonCode` from `SafetyReasonCode`. |
| Dispatchers    | `packages/agent/src/tasks/_tasks-symbols.ts`, `packages/agent/src/tasks/kb-reembed-work-dispatcher.ts`, `packages/agent/src/tasks/index.ts`, `packages/tasks/src/tasks/trigger/index.ts`                                                 | The `*_DISPATCHER` symbol + barrel drift guard pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Telemetry      | `packages/agent/src/services/knowledge-base-reconcile.service.ts`                                                                                                                                                                        | `posthog.capture({ distinctId, event, properties })` pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Web            | `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx`, `apps/web/src/components/works/detail/overview/`                                                                                                                            | Work Overview server page composing `WorkInfo`, `WorkStats`, `WorkConfig`, `WorkMissions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Web            | `apps/web/src/lib/api/work.ts`, `apps/web/src/app/actions/dashboard/works.ts`, `apps/web/src/lib/ai/tools/work.tools.ts`                                                                                                                 | Work API client, server actions, chat tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Entities       | `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`, `packages/agent/src/database/_entities-inventory.ts`, `packages/agent/src/entities/_types.ts`, `apps/api/src/scope/scope-stamping.subscriber.ts` | Entity registration + `PortableDateColumn` + scope stamping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Migrations     | `apps/api/src/migrations/`                                                                                                                                                                                                               | Newest on `develop` @ `ee45946e5`: `1791240000000-AddSafetyRailsCore.ts` (`1791200100000-CreateOnboardingChecklists.ts` when authored).                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 1.2 The exact blockers

1. **The quality gate cannot express this verification.** `TaskGateRunnerService` spawns shell commands in the
   checkout before the push. Build → boot → smoke needs a pushed branch, a build capability, a runtime and minutes
   of waiting. A new, platform-evaluated gate path is required (§2.3). It reuses the gate's attempt clamp
   (`MIN/MAX_GATE_ATTEMPTS`) and verdict vocabulary, and the post-PR resume shape of CI auto-resume.
2. **Restricted egress exists on one pipeline only.** Environments' `limited` networking is enforced by
   `claude-managed-agent` alone. Provisioning must refuse any pipeline that does not enforce it (§7.3).
3. **The cloud checkout inherits the process environment.** Its git process runs with the worker environment (described generically here per Resolution R-14).
   It is therefore used only as the **writer** checkout (git only, never repository code), never as the analysis
   sandbox (§2.2).
4. **Repo-backed agent templates cannot be instantiated server-side.** `AgentTemplatesService.createFromTemplate`
   reads in-code presets; the `ever-works/agents` catalog is list-only. ADR-014 forbids adding the Provisioner as an
   in-code preset, so a repo-template instantiation path is added (§7.1).
5. **`allowed-tools` is not read.** Catalog `SKILL.md` files use the agentskills string; the platform reads
   `allowedTools` arrays. The draft Skill declares both (§7.2).
6. **`finalizeRun` always opens the PR and moves the Task to `in_review`.** Provisioning needs push-without-PR and
   PR-without-review-transition variants (§7.6).
7. **No per-Task token cap.** Agent budgets are monthly cents; the managed-agent session cap is USD per session.
   Provisioning caps are enforced at run/build boundaries by this epic (§6.4), with the session cap as a backstop.
8. **Cross-epic capabilities do not exist yet**: `app` kind spec schema + validator (APW-03), `IBuildPlugin` (APW-05),
   `IDeploymentPlugin.deployApp` (APW-06), env generation (APW-07). §8 fixes what this epic consumes.

---

## 2. Architecture

### 2.1 One service, one job, one guard, one gate path

```
                           ┌────────────────────────────────────────────────────────────┐
  POST /provision ────────►│ AppProvisioningService (new, agent pkg)                    │
  APW-01 create hook ─────►│  start · cancel · notify(event) · readiness · suggest       │
  APW-02/05/06 events ────►│  writes work_app_provisionings; dispatches app-provision    │
                           └───────────────┬────────────────────────────────────────────┘
                                           │ APP_PROVISION_DISPATCHER (job-runtime provider)
                                           ▼
                  ┌───────────────── job `app-provision` (step executor, lease-guarded) ─────────────────┐
                  │ repository ─► analysis ─► output guard ─► writer push ─► PR ─► validate ─► build ─►   │
                  │ boot ─► smoke ─► evidence ─► (green) succeeded │ (red) resume run │ (spent) ask        │
                  └──────┬──────────────┬──────────────────┬─────────────┬─────────────┬─────────────────┘
                         │              │                  │             │             │
             AppProvisionerAgent   ProvisionOutputGuard  TaskWorkspace  BuildFacade   AppVerification-
             Resolver (template,   (pure: paths, sizes,  Service (new   (APW-05)      TargetService
             skill, grants,        secrets, preserved    push-only / PR               (APW-06 deployApp
             sandbox Environment)  fields, APW-03 schema) variants)                   purpose=verification
                                                                                       or runner boot)
```

Nothing in the analysis sandbox can reach the platform: platform tools run in the run host, the job runs in the
worker, and the writer checkout lives in the worker's workspace provider.

### 2.2 Two workspaces, on purpose

| Workspace            | Where                                                                                                    | Holds credentials | Runs repository code | Network                         |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- | -------------------- | ------------------------------- |
| **Analysis sandbox** | The pipeline's managed sandbox; repository mounted from `attachedRepos` at the Task branch (or base ref) | No                | May (reads, parsers) | `limited`: §7.3 allow-list only |
| **Writer checkout**  | `workspace` capability in the worker (`sandbox-workspace`)                                               | Per-command token | Never (git only)     | Git host only (worker default)  |

The analysis run returns files **as data** (§3.3). The job validates them, writes them into the writer checkout, and
pushes. Public data repositories mount tokenlessly; a private copy mounts with a read-only (`contents: read`),
repository-scoped installation token minted per run through `GitFacadeService.getInstallationTokenForOwner`, handed
to the pipeline's repository mount only — never to the model environment (verify the mount path keeps it out of the
sandbox shell in T6; otherwise private copies are refused in P1).

### 2.3 The verification gate path

```mermaid
sequenceDiagram
    participant J as app-provision job
    participant R as Run (Agent + provision-app)
    participant G as ProvisionOutputGuard
    participant W as Writer checkout
    participant V as APW-03 validator
    participant B as Build plugin (APW-05)
    participant T as Verification target (APW-06 / runner)
    participant P as Pull request
    J->>R: dispatch analysis run (Environment=limited, grants=deny-list)
    R-->>J: run finished + provision-output block
    J->>G: check(output, baseSpec)
    alt guard red
        J->>R: resume with rejected paths / variables (attempt n consumed)
    else guard green
        J->>W: provision task branch, write files, push
        J->>P: open PR (first time) — Task stays in_progress
        J->>V: validate .works/works.yml @ head
        J->>B: startBuild(head, verification)
        B-->>J: build status (poll 30 s; webhook when available)
        J->>T: boot (cluster namespace or runner) + jobs + probes
        J->>T: smoke (spec smoke + negative tests)
        J->>P: evidence comment
        alt all green
            J->>J: status=succeeded; Task → in_review
        else red, attempts left, new fingerprint
            J->>R: resume with evidence (fenced, redacted)
        else spent / repeat fingerprint / blocked / cap
            J->>R: resume with "ask" instruction; guard question; fallback compose
        end
    end
```

`agent-task-execute.task.ts` gains one guarded branch: when `AppProvisioningRepository.findByTaskId(task.id)`
returns a row, the worker **skips** workspace provisioning, the L0 pre-check and the command gate loop, and does not run
the default post-run `finalizeRun`; it passes the provisioning's `runtimeEnvironment` and `attachedRepos`, and on
completion calls `AppProvisioningService.notify({ event: 'run-finished', runId })`. Finalize is **deferred to the job**:
after the output guard passes, the job pushes and opens the pull request through the Task finalize variants of §7.6
(`TaskWorkspaceService` → `WorkspaceFacadeService.finalize` → `openPullRequestForBranch`) — never through the agent
`commitToRepo` / `openPullRequest` tools, which stay denied (R-17). Every other Task is byte-identical.

### 2.4 Verification target selection (per attempt)

```
App Work target = your-cluster AND checkAppCluster OK within 10 s ─► target = cluster (via app-cluster-op, isolated worker)
   ├─ production without EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true ─► cluster jobs refused ─► target = runner
   └─ namespace Pending on insufficient resources > 10 min ─► infra verdict, retry once on runner
otherwise (None · unreachable · Ever Works Apps not enabled) ─────────────► target = runner
   └─ summed component + dependency memory > 12 GiB ─► boot `blocked` ─► ask (verify on cluster / accept build-only / stop)
```

### 2.5 Step table

| Step       | Action                                                                        | Waits on                           | Green when                              | Red / other                                                                    |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| repository | Wait for `app.fork.ready` (APW-02) or confirm the linked repo                 | event or 60 s poll, ≤ 30 min       | repo readable, checkout ≤ 3 GiB         | `repository-not-ready` / `repository-too-large`                                |
| analysis   | Ensure Agent + Task; dispatch run                                             | run terminal, ≤ 45 min             | run completed with a parseable output   | no output → attempt red "no output"                                            |
| proposal   | Guard; writer push; open PR once                                              | —                                  | guard green, push ok                    | guard red → resume; push conflict → rebase writer, retry once                  |
| validate   | APW-03 validator on head                                                      | —                                  | valid                                   | red with validator messages                                                    |
| build      | `startBuild` (verification)                                                   | build terminal, ≤ 60 min           | succeeded + digest                      | red; infra → retry (≤ 3 / 30 min)                                              |
| boot       | jobs (`pre-deploy`, `first-deploy`) in order, then components; startup probes | ≤ 15 min per job, ≤ 15 min startup | every job exit 0, every component ready | red (job exit, crash loop, probe timeout); `blocked` (missing value, capacity) |
| smoke      | spec smoke + negative tests; 30 s each, 5 min total                           | —                                  | all required green                      | red with table                                                                 |
| evidence   | PR comment + run evidence + card                                              | —                                  | always                                  | comment failure logged, never fails the attempt                                |

---

## 3. Data model

**Workspace backup (Resolution R-25).** `WorkAppProvisioning` exports as `data/works/app-provisionings.jsonl` through the parent Work ids (`tokenCap` reviewed as benign); `Organization.appProvisionCaps` rides the existing organizations file ([tasks](./tasks.md) T47).

### 3.1 `work_app_provisionings` (new entity `WorkAppProvisioning`)

`packages/agent/src/entities/work-app-provisioning.entity.ts` **(new)**. Derived state only (Constitution III).

| Column                                                                     | Type                                                                            | Notes                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`                                                                       | `uuid` PK                                                                       |                                                                                        |
| `workId`                                                                   | `uuid NOT NULL`                                                                 | `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`                                      |
| `userId`                                                                   | `uuid NOT NULL`                                                                 | starter; question recipient (owner for automatic starts)                               |
| `tenantId`, `organizationId`                                               | `uuid NULL`                                                                     | scope stamps, no relation                                                              |
| `taskId`, `agentId`                                                        | `uuid NULL`                                                                     | no FK (entity-cycle rule)                                                              |
| `trigger`                                                                  | `varchar(24)`                                                                   | `auto-create` · `manual` · `chat` · `upstream-smoke` · `auto-upstream-smoke`           |
| `status`                                                                   | `varchar(16)`                                                                   | `queued` · `running` · `needs_input` · `succeeded` · `merged` · `failed` · `cancelled` |
| `queuedReason`                                                             | `varchar(24) NULL`                                                              | `user-limit` · `org-limit`                                                             |
| `step`                                                                     | `varchar(16)`                                                                   | §2.5 step ids                                                                          |
| `stepStates`                                                               | `simple-json`                                                                   | `Record<Step, { state, startedAt?, finishedAt?, noteKey?, noteParams? }>`              |
| `detectionSource`                                                          | `varchar(24) NULL`                                                              | `app-spec` · `compose` · `dockerfile` · `helm` · `descriptor-hint` · `auto` (R-13)     |
| `verified`                                                                 | `boolean NULL`                                                                  | set on `merged`                                                                        |
| `failureReason`                                                            | `varchar(40) NULL`                                                              | spec §5.3 closed set                                                                   |
| `baseSha`, `headSha`                                                       | `varchar(64) NULL`                                                              |                                                                                        |
| `prNumber` / `prUrl`                                                       | `int NULL` / `varchar(512) NULL`                                                |                                                                                        |
| `attempts`                                                                 | `simple-json`                                                                   | `AppProvisioningAttempt[]`, ≤ 9 (§3.2)                                                 |
| `attemptBudget`, `attemptsUsed`, `questionsAsked`                          | `int NOT NULL`                                                                  | defaults 3 / 0 / 0; `attemptsUsed` advanced by compare-and-set                         |
| `openInboxItemId`, `questionAskedAt`, `questionRemindedAt`                 | `uuid NULL`, `timestamptz NULL` ×2                                              |                                                                                        |
| `tokensUsed`, `tokenCap`                                                   | `bigint NOT NULL`                                                               | cap default 3,000,000                                                                  |
| `runnerMinutesUsed`, `runnerMinuteCap`                                     | `int NOT NULL`                                                                  | cap default 240                                                                        |
| `activeMs`                                                                 | `bigint NOT NULL default 0`                                                     | accrues outside `needs_input` and while not parked; deadline 8 h                       |
| `parkedReason`, `parkedAt`                                                 | `varchar(24) NULL`, `timestamptz NULL`                                          | `kill-switch` · `agent-paused` · `workspace-paused` · `scope-paused` (R-17 waits)      |
| `runIds`, `buildIds`                                                       | `simple-json`                                                                   | ≤ 16 / ≤ 9                                                                             |
| `verificationTargetKind`, `verificationNamespace`, `verificationExpiresAt` | `varchar(16) NULL`, `varchar(63) NULL`, `timestamptz NULL`                      | sweeper input                                                                          |
| `conversationId`, `chatMessagesPosted`                                     | `uuid NULL`, `int default 0`                                                    | ≤ 12                                                                                   |
| `note`                                                                     | `varchar(500) NULL`                                                             | "anything to tell the agent" (fenced as user input)                                    |
| `upstreamFromSha`, `upstreamToSha`                                         | `varchar(64) NULL`                                                              | upstream-smoke trigger range                                                           |
| `suggestionState`, `suggestionUpstream`, `suggestedAt`, `suggestionBundle` | `varchar(16) NULL`, `varchar(200) NULL`, `timestamptz NULL`, `simple-json NULL` | bundle ≤ 256 KB                                                                        |
| `lease`, `leaseExpiresAt`                                                  | `varchar(36) NULL`, `timestamptz NULL`                                          | step executor CAS; lease 5 min                                                         |
| `startedAt`, `finishedAt`, `createdAt`, `updatedAt`                        | `timestamptz`                                                                   | `PortableDateColumn`                                                                   |

Indexes:

| Index                                    | Definition                                                             | Why                         |
| ---------------------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| `uq_work_app_provisionings_active`       | UNIQUE `(workId)` WHERE `status IN ('queued','running','needs_input')` | one active per App Work     |
| `uq_work_app_provisionings_task`         | UNIQUE `(taskId)` WHERE `taskId IS NOT NULL`                           | worker lookup, one per Task |
| `idx_work_app_provisionings_user_status` | `(userId, status)`                                                     | per-user cap (3)            |
| `idx_work_app_provisionings_org_status`  | `(organizationId, status)`                                             | per-org cap (10)            |
| `idx_work_app_provisionings_expiry`      | `(verificationExpiresAt)`                                              | sweeper                     |
| `uq_work_app_provisionings_suggestion`   | UNIQUE `(suggestionUpstream)` WHERE `suggestionState = 'queued'`       | one open per upstream       |

Registration (the database drift specs fail otherwise): `export *` in `packages/agent/src/entities/index.ts`;
`'WorkAppProvisioning'` in `AGENT_ENTITY_NAMES` (`_entity-names.ts`); import + `ENTITIES` entry in
`_entities-inventory.ts`; `TypeOrmModule.forFeature` in the new `packages/agent/src/app-provisioning/app-provisioning.module.ts`.

### 3.2 Contracts — `packages/contracts/src/apps/app-provisioning.ts` (new)

Re-exported from `packages/contracts/src/apps/index.ts` (created by APW-03 T1; this epic adds one `export *` line) —
the program's single shared-types folder (R-1).

```ts
export const APP_PROVISIONING_STATUSES = [
	'queued',
	'running',
	'needs_input',
	'succeeded',
	'merged',
	'failed',
	'cancelled'
] as const;
export const APP_PROVISIONING_STEPS = [
	'repository',
	'analysis',
	'proposal',
	'validate',
	'build',
	'boot',
	'smoke',
	'evidence'
] as const;
export const APP_PROVISIONING_STEP_STATES = ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped'] as const;
export const APP_PROVISIONING_FAILURE_REASONS = [
	'no-isolated-runtime',
	'repository-not-ready',
	'repository-too-large',
	'not-runnable',
	'token-cap',
	'runner-minute-cap',
	'deadline',
	'could-not-verify',
	'no-answer',
	'verification-infrastructure'
] as const;
export const APP_PROVISIONING_QUESTION_REASONS = [
	'attempts-spent',
	'repeated-failure',
	'missing-required-value',
	'runner-capacity',
	'token-cap',
	'runner-minute-cap',
	'multiple-apps',
	'agent-asked',
	'safety-rail' // R-17: a rail refused or held an action (grants, ladder, caps, rules)
] as const;
/** R-17 waits: a parked run consumes no attempt and no active time. */
export const APP_PROVISIONING_PARK_REASONS = [
	'kill-switch',
	'agent-paused',
	'workspace-paused',
	'scope-paused'
] as const;
export const APP_PROVISIONING_DETECTION_SOURCES = [
	'app-spec',
	'compose',
	'dockerfile',
	'helm',
	'descriptor-hint',
	'auto' // R-13 zero-config build; the builder is the build plugin's choice
] as const;

export interface AppProvisioningAttempt {
	n: number;
	startedAt: string;
	finishedAt?: string;
	verdict: 'green' | 'red' | 'infra' | 'blocked' | 'running';
	failedStep?: (typeof APP_PROVISIONING_STEPS)[number];
	fingerprint?: string; // sha256 of normalised failure (loop-detector normalisation)
	targetKind?: 'cluster' | 'runner';
	buildId?: string;
	imageDigest?: string;
	logsUrl?: string;
	smoke?: Array<{ name: string; expected: string; observed: string; ms: number; ok: boolean }>; // ≤ 40
	commentId?: number;
	tokens: number;
	runnerMinutes: number;
}

export const APP_PROVISION_LIMITS = {
	attemptsDefault: 3,
	attemptsMin: 1,
	attemptsMax: 5,
	attemptsPerAnswer: 2,
	questionsMax: 3,
	attemptsCeiling: 9,
	optionsMax: 4,
	tokenCapDefault: 3_000_000,
	tokenCapMin: 500_000,
	tokenCapMax: 10_000_000,
	runnerMinuteCapDefault: 240,
	runnerMinuteCapMin: 60,
	runnerMinuteCapMax: 600,
	analysisRunMs: 45 * 60_000,
	iterateRunMs: 30 * 60_000,
	forkWaitMs: 30 * 60_000,
	activeDeadlineMs: 8 * 3_600_000,
	buildMinutesMax: 60,
	jobSecondsMax: 900,
	startupSecondsMax: 900,
	smokeRequestMs: 30_000,
	smokeTotalMs: 300_000,
	runnerBootMinutesMax: 30,
	runnerBootMemoryGiB: 12,
	buildMemoryGiBMax: 14,
	namespaceTtlMinutes: 90,
	repoMaxBytes: 3 * 1024 ** 3,
	diffMaxFiles: 12,
	diffMaxLines: 3_000,
	fileMaxBytes: 128 * 1024,
	outputMaxBytes: 512 * 1024,
	reportMaxChars: 40_000,
	instructionFileMaxBytes: 32 * 1024,
	logTailLines: 200,
	logTailBytes: 16 * 1024,
	evidenceCommentMaxChars: 60_000,
	chatMessagesMax: 12,
	questionReminderMs: 72 * 3_600_000,
	questionExpiryMs: 14 * 86_400_000,
	activePerUser: 3,
	activePerOrg: 10,
	startsPerHour: 10,
	pollMs: 5_000,
	infraRetries: 3,
	infraRetryWindowMs: 30 * 60_000,
	suggestionsPer30Days: 5,
	autoReprovisionPerSync: 1,
	autoReprovisionPer7Days: 2,
	clusterProbeMs: 10_000,
	podPendingInfraMs: 10 * 60_000
} as const;

export const APP_PROVISION_WRITABLE_PATHS = ['.works/works.yml', '.works/overlay/**'] as const;
export const APP_PROVISION_PRESERVED_SPEC_FIELDS = [
	'source',
	'blueprint',
	'license',
	'display.protectedPaths',
	'upstreamSync',
	'upstreamPullRequests',
	'provisioning'
] as const;
```

### 3.3 The run output contract

The Skill ends every run with exactly one fenced block tagged `provision-output`; the job takes the **last** such block
of the final assistant message and ignores prose. Parsed with a strict Zod schema in
`packages/agent/src/app-provisioning/provision-output.schema.ts` **(new)**:

```ts
{
  version: 1,
  outcome: 'proposal' | 'no-change' | 'not-runnable' | 'question',
  detection: { source: DetectionSource, evidence: string[] /* ≤ 20 file paths */ },
  files: Array<{ path: string; content: string }>,       // ≤ 12; empty unless outcome = proposal
  report: string,                                        // Markdown, ≤ 40,000 chars
  risks: Array<{ kind: 'bootstrap-endpoint' | 'cron-auth' | 'swallowed-migration' | 'secret-shape'
               | 'build-memory' | 'open-signup' | 'telemetry' | 'trademark'; file: string; note: string }>, // ≤ 20
  instructionFilesRead: string[],                        // ≤ 8
  question?: { reason: 'multiple-apps' | 'missing-required-value' | 'agent-asked'; context: string /* ≤ 2,000 */;
               candidates?: string[] /* ≤ 4 */ },
  notRunnableReason?: string                             // ≤ 1,000
}
```

The block is ≤ 512 KB; larger output is a red attempt ("output too large").

### 3.4 Migration (Constitution V)

`apps/api/src/migrations/1792040000000-CreateWorkAppProvisionings.ts` **(new)** — APW-04 slot 00 of the program's
reserved block, above `1791240000000-AddSafetyRailsCore.ts` (newest on `ee45946e5`); re-stamp before merge if `develop` moved.
`up()`: create the table and the six indexes (partial indexes on Postgres and SQLite, branching on
`queryRunner.connection.options.type` like existing raw-SQL migrations). `down()`: drop indexes then the table.
Nothing pre-existing is altered.

---

## 4. API

Controller `apps/api/src/works/app-provisioning.controller.ts` **(new)**, DTOs
`apps/api/src/works/dto/app-provisioning.dto.ts` **(new)**. JWT-guarded, scoped with the controller conventions of
`apps/api/src/works/works.controller.ts`; another scope's id answers **404** on every verb.

| Method | Path                                                                                | Body / response                                                                                                                                                                 | Throttle           |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `POST` | `/api/works/:id/provision` (CONTRACTS §4, 202)                                      | `{ restart?: boolean; note?: string (≤ 500) }` → `{ provisioningId, status, deduplicated }`                                                                                     | 10 / hour / user   |
| `GET`  | `/api/works/:id/provisioning` **(added to CONTRACTS §4)**                           | `{ active, recent (≤ 10), readiness: { isolatedRuntime, agentTemplate, buildCapability, clusterTarget }, upstreamSmokeBroken: { fromSha, toSha } \| null, suggestionEligible }` | default            |
| `POST` | `/api/works/:id/provision/cancel` **(added, 202)**                                  | → `{ provisioningId, status: 'cancelled' }`; idempotent                                                                                                                         | 30 / minute        |
| `POST` | `/api/works/:id/provisioning/:provisioningId/blueprint-suggestion` **(added, 202)** | `{ consent: true }` → `{ suggestionState: 'queued' }`                                                                                                                           | 5 / 30 days / user |
| `GET`  | `/api/admin/app-blueprint-suggestions` **(added, P3, platform admin)**              | paginated (≤ 50) list + `GET …/:provisioningId/bundle`                                                                                                                          | default            |

Error contract:

| Situation                                        | Status | Body                                                                   |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| Work is not kind `app`                           | `422`  | `{ code: 'notAppWork' }`                                               |
| Readiness flag false                             | `422`  | `{ code: 'provisioningUnavailable', missing: ['isolatedRuntime', …] }` |
| Active provisioning and `restart !== true`       | `409`  | `{ code: 'provisioningActive', provisioningId, status }`               |
| Duplicate start within the partial-unique window | `202`  | `{ provisioningId, deduplicated: true }`                               |
| Suggestion not eligible                          | `422`  | `{ code: 'suggestionNotEligible', reason }`                            |
| Suggestion already open for the upstream         | `409`  | `{ code: 'suggestionExists' }`                                         |
| Caller lacks edit permission on the Work         | `404`  | same as missing                                                        |

The chat tool `provisionAppWork` in `apps/web/src/lib/ai/tools/work.tools.ts` calls the POST with
`requiresConfirmation: true` (spends money).

---

## 5. Web

| File                                                                                    | Type   | Notes                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/works/detail/overview/AppProvisioningCard.tsx` **(new)**       | client | Header, headline by state (spec §6), actions, spend line, receipts link; polls every 5,000 ms while `queued/running/needs_input`; no timer when terminal. |
| `apps/web/src/components/works/detail/overview/AppProvisioningSteps.tsx` **(new)**      | client | 8 rows: icon + text state (`aria-label`), note, elapsed; attempt counter.                                                                                 |
| `apps/web/src/components/works/detail/overview/AppReprovisionDialog.tsx` **(new)**      | client | Caps, running-provisioning variant ("Cancel it and start over?"), note field (≤ 500).                                                                     |
| `apps/web/src/components/works/detail/overview/AppBlueprintSuggestDialog.tsx` **(new)** | client | Consent checkbox gates the submit button.                                                                                                                 |
| `apps/web/src/app/api/works/[id]/provisioning/route.ts` **(new)**                       | BFF    | `GET` proxy for the poll (mirrors existing BFF proxies).                                                                                                  |
| `apps/web/src/app/[locale]/(dashboard)/works/[id]/page.tsx`                             | modify | For `work.kind === 'app'`, server-fetch `GET /provisioning` in the existing `.catch`-guarded style and render the card above `WorkInfo`.                  |
| `apps/web/src/lib/api/work.ts`                                                          | modify | `getAppProvisioning`, `startAppProvisioning`, `cancelAppProvisioning`, `suggestAppBlueprint` + DTO mirror types.                                          |
| `apps/web/src/app/actions/dashboard/works.ts`                                           | modify | `startAppProvisioningAction`, `cancelAppProvisioningAction`, `suggestAppBlueprintAction` with `revalidatePath`.                                           |

"Answer in My Decisions" links to `/inbox?view=decisions`; "Receipts" links to the run receipts of `runIds` and the
Builds page of APW-05. Viewers get the card with actions hidden (server returns `canEdit`).

---

## 6. Background work (Constitution IV)

### 6.1 Dispatcher

`packages/agent/src/tasks/app-provision-dispatcher.ts` **(new)**:

```ts
export type AppProvisionEvent =
	| 'start'
	| 'fork-ready'
	| 'run-finished'
	| 'build-updated'
	| 'target-updated'
	| 'answered'
	| 'pr-state'
	| 'cancel'
	| 'tick';
export interface AppProvisionDispatcher {
	dispatchAppProvision(payload: {
		provisioningId: string;
		event: AppProvisionEvent;
		refId?: string;
		delayMs?: number;
	}): Promise<string>;
}
export const APP_PROVISION_DISPATCHER = Symbol('APP_PROVISION_DISPATCHER');
```

Errors **propagate** (a dropped `start` would strand an active row that blocks the App Work). Symbol listed in
`TASKS_BARREL_RUNTIME_SYMBOLS` (`_tasks-symbols.ts`) and exported from `packages/agent/src/tasks/index.ts`.

### 6.2 Job `app-provision` (CONTRACTS §5)

`packages/tasks/src/tasks/trigger/app-provision.task.ts` **(new)**; registered in `packages/tasks/src/tasks/trigger/index.ts`.

- Claims the row's `lease` with `UPDATE … SET lease = :new, leaseExpiresAt = now()+5 min WHERE id = :id AND (lease IS NULL OR leaseExpiresAt < now())`;
  a lost claim exits quietly (another worker holds it). Releases on exit.
- Executes `AppProvisioningStepRunner.advance(row, event)` **(new, agent pkg)** — a pure-ish state machine over §2.5 that
  returns `{ patch, effects[] }`; effects (dispatch run, start build, deploy target, comment, ask, activity, chat) are
  applied after the row patch commits, each idempotent by `(provisioningId, attempt, effect)`.
- Waits re-dispatch with `delayMs` (build poll 30,000 ms; boot poll 15,000 ms; fork poll 60,000 ms).
- `maxDuration` 10 minutes per invocation; retries 2.
- Checks the global stop flag (`run-kill-switch.ts`) before any spending effect; a set or unreadable flag parks the row
  with `parkedReason: kill-switch`, step note `waitPlatform`, and re-ticks in 5 minutes (a wait — R-17, below).
- _Safety rails (R-17, AW-23/AW-24):_ the provisioning run itself is dispatched through the assign-task path, so
  `RunDispatchGateService` applies `DEFAULT_RUN_ADMISSION_CHAIN` (stop flag → Agent brake → …). The step runner maps
  outcomes as follows:
    - **Wait** — a run parked at admission with `queuedReason` `kill-switch` (`QUEUED_REASON_KILL_SWITCH`) or
      `agent-paused` (`QUEUED_REASON_AGENT_PAUSED`), or a run whose tool call the safety gate refused with
      `reasonCode` `platform-stopped`, `workspace-paused` or `scope-paused`: `parkedReason` / `parkedAt` set, no attempt
      consumed (`attemptsUsed` untouched), no infra retry spent, `activeMs` stops accruing, step note `waitPlatform` /
      `waitAgent` / `waitWorkspace`; the job re-ticks every 5 minutes and resumes the same run when the stop is lifted.
    - **Needs input** — a run that ends on a safety-gate `refused` or `held` verdict with any other `reasonCode`
      (`grant-denied`, `rung-off`, `rung-held`, `ceiling-refused`, `cap-reached`, `rule-blocked`, `policy-refused`,
      `unclassified-action`, `instruction-widening-attempt`, `non-human-actor`, `safe-mode`): status `needs_input`,
      question reason `safety-rail` (options `retry`, `stop`), never a red attempt.
    - The Agent brake is not re-implemented here; the job only reads the parked state the admission chain and the gate
      already record.

### 6.3 Sweeper `app-provision-sweep` (added to CONTRACTS §5)

`packages/tasks/src/tasks/trigger/app-provision-sweep.task.ts` **(new)**, cron `7,22,37,52 * * * *` (every 15 minutes, off
the hour). Per tick, each capped at 200 rows:

1. `verificationExpiresAt < now()` → destroy target (APW-06 `destroyApp` on the verification namespace), clear columns.
2. `leaseExpiresAt < now() - 10 min` on active rows → clear lease, dispatch `tick`.
3. `activeMs > 8 h` → `failed/deadline`.
4. `needs_input` and `questionAskedAt < now() - 72 h` and no reminder → one reminder Inbox notice;
   `< now() - 14 d` → `failed/no-answer` (PR left open).
5. `queued` rows oldest first → promote while user (3) and org (10) caps allow.
6. Open `prNumber` rows whose Task `prState` is `closed`/`merged` (from `task-pr-status.service.ts`) → `pr-state` event.

### 6.4 Caps and receipts

- **Tokens**: after each run terminal, `tokensUsed += ledger tokens` read through `RunReceiptService.getReceipt(runId)`.
  Before dispatching a run: refuse when `tokensUsed ≥ tokenCap`. The pipeline's per-session USD budget is set to the
  remaining token allowance priced at the resolved model (backstop inside a run).
- **Runner minutes**: after each build/boot terminal, `runnerMinutesUsed += WorkBuild.duration` (APW-05). Before
  starting a build: refuse when `runnerMinutesUsed + buildMinutesMax > runnerMinuteCap`.
- A refused dispatch asks with reason `token-cap` / `runner-minute-cap`; option "Raise the cap by 1,000,000 tokens" /
  "by 60 runner minutes" creates an approval proposal of action type `budget_override` (guardrails always queue it,
  risk flag `budget_override`); approval raises the cap on the row and dispatches `answered`.
- Organization defaults: `tokenCap`/`runnerMinuteCap` resolved from instance env
  `EVER_WORKS_APP_PROVISION_TOKEN_CAP` / `EVER_WORKS_APP_PROVISION_RUNNER_MINUTE_CAP` (added to CONTRACTS §7), clamped to
  §3.2 bounds; per-Organization override is P3 (organization settings JSON, additive).

### 6.5 Events in and out

Other epics notify through a port, avoiding import cycles:
`packages/agent/src/app-provisioning/app-provision-events.port.ts` **(new)** exports `APP_PROVISION_EVENTS_PORT` with
`forkReady(workId)`, `buildUpdated(buildId)`, `targetUpdated(workId, namespace)`, `smokeFailedAfterUpstreamSync(workId, fromSha, toSha)`.
`InboxService` reply routing calls `notify({ event: 'answered' })` when the answered item id matches
`openInboxItemId` (one additive call beside the existing resume path).

Activity (CONTRACTS §6, `app.provision.*`) via `ActivityLogService.log` with `action` = the dotted name and
`actionType` = `ActivityActionType.APP_PROVISION` (`'app_provision'`, appended to
`packages/agent/src/entities/activity-log.types.ts`, R-2), names and counts only:
`started {trigger}`, `proposed {prNumber}`, `attempted {n, verdict, failedStep, targetKind}` **(added)**,
`needs_input {reason}`, `succeeded {attempts, tokens, runnerMinutes, detectionSource}`,
`failed {reason, attempts, tokens, runnerMinutes}`, `blueprint_suggested {upstream}` **(added)**.

---

## 7. Agent, Skill, sandbox and defences

### 7.1 The Agent

- Template `ever-works/agents/templates/app-provisioner/` (draft in [`agent-template-draft/`](./agent-template-draft/)).
- `AppProvisionerAgentResolver` **(new, `packages/agent/src/app-provisioning/`)** reuses the `agentId` of the caller's
  (or Organization's) most recent `work_app_provisionings` row when that Agent still exists and is not archived, else
  creates one. `agent.entity.ts` has no template-slug column, and this epic does not add one — the provisioning rows
  are the memory.
- Creation path: `AgentTemplatesService.createFromRepoTemplate(userId, slug, input, scope)` **(new, additive)** — reads
  `templates/<slug>/.works/agent.yml`, `SOUL.md`, `skills.yml` through the same pinned-ref reader as
  `AgentTemplateCatalogService` (tokenless raw read, App-installation fallback), validates the manifest against the
  catalog schema's required keys, strips HTML, caps lengths, writes `SOUL.md` through `AgentFileService.write`, applies
  permissions (all false) and guardrails `require_approval`. Only slugs in an allow-list constant
  `REPO_TEMPLATE_INSTANTIABLE_SLUGS = ['app-provisioner']` may be instantiated in P1 (widening is a separate decision).
- Scope: tenant-scoped Agent; one per user, or per Organization when the App Work has an `organizationId`.

### 7.2 The Skill

- `ever-works/skills/skills/provision-app/SKILL.md` (draft in [`skill-draft/SKILL.md`](./skill-draft/SKILL.md)) plus a
  `manifest.json` row (`slug`, `path`, `name`, `summary`, `skillPath`, `tags`, `version`, `license`).
- Installed with `SkillsService.installFromCatalog` on Agent creation, bound `injectIntoAgent: true`, priority 10.
- Frontmatter carries `allowed-tools` (agentskills string) **and** `allowedTools` (array the platform reads).
- Drift guard: `AppProvisionerAgentResolver` refuses to dispatch when the Skill is missing, unbound or disabled and
  re-installs it once; still missing → readiness `agentTemplate: false`.

### 7.3 The sandbox

- Pipeline selection goes through the facade by capability flag, never a plugin id: `IPipelinePlugin` gains
  `readonly enforcesRuntimeNetworking?: boolean` **(additive, `pipeline-plugin.interface.ts`)**, set `true` only in
  `packages/plugins/claude-managed-agent/`. Readiness `isolatedRuntime` = the Agent's resolved pipeline has the flag;
  otherwise the resolver pins the first enabled pipeline that has it; none → 422 `provisioningUnavailable`.
- The run receives a **pre-resolved** `runtimeEnvironment` (never a stored Environment the user could edit):
  `networkingMode: 'limited'`, `allowPackageManagers: true`, no packages, `allowedHosts`:
  `github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`,
  `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`,
  `sum.golang.org`, `index.crates.io`, `static.crates.io`, `rubygems.org`, `repo.maven.apache.org`,
  `repo.packagist.org`, `api.nuget.org`, `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`, `quay.io`.
  Nothing else; the host validator in `environments.service.ts` already rejects IP literals, `localhost`, `.local`,
  `.internal`.
- `attachedRepos`: exactly one entry (the data repository at the Task branch once pushed, else the base ref), `mountDir`
  `repo`. No env files.
- Wall clock via pipeline `timeout`: 45 min (analysis) / 30 min (iterate).

### 7.4 Tool grants

Written on Agent creation and re-asserted before every dispatch (a user edit that widens them blocks dispatch with
readiness `agentTemplate: false` and a card note):

- **Deny** (the proposal's push and pull request are the platform's, through Task finalize — §7.6, R-17):
  `commitToRepo`, `openPullRequest`, `searchWeb`, `extractContent`, `sendEmail`, `messageAgent`,
  `notifyChannel`, `delegateToAgent`, `createSubAgent`, `editAgentFile`, `screenshot`, and all MCP tools
  (`canCallExternalTools: false`).
- **Allow**: `ask_human`; `appProvisionReport` **(new)** — `{ stepNote: string ≤ 280 }`, 1 call / minute, updates the
  analysis step note only; `appSpecValidateDraft` **(new)** — `{ yaml: string ≤ 128 KB }` → APW-03 validator messages
  (pure, no I/O beyond the validator). Both in `packages/agent/src/app-provisioning/app-provision-tools.ts` and exposed
  only when the run's Task has a provisioning row.

### 7.5 Prompt assembly

Composed by `AppProvisionPromptBuilder` **(new)**: Skill body (trusted) → Task brief (trusted: repo, deploy target,
caps, writable paths, output contract, and `buildStrategies` — the `supportedStrategies` of the App Work's resolved
build plugin (APW-05 `IBuildPlugin`), so detection step 6 proposes `build.strategy: auto` only when `auto` is listed and
otherwise writes an overlay Dockerfile; the brief never names the builder behind `auto`, R-13) → user note (fenced as user input) → upstream instruction files (fenced
`UNTRUSTED PROJECT INSTRUCTIONS`, each ≤ 32 KB) → on iterate: evidence (fenced `UNTRUSTED BUILD/SMOKE OUTPUT`,
redacted, ≤ 200 lines / 16 KB). Fencing reuses the delimiter + neutralisation approach of `memory-recall.ts`.

### 7.6 Guard, writer and pull request

- `ProvisionOutputGuard.check(output, baseSpecYaml)` **(new, pure)** in `packages/agent/src/app-provisioning/provision-output.guard.ts`:
  paths ∈ `APP_PROVISION_WRITABLE_PATHS` (normalised, no `..`, no symlink semantics — content only); ≤ 12 files,
  ≤ 3,000 changed lines, ≤ 128 KB each; `scanForSecrets` on every file, report and question context; YAML parses;
  APW-03 `validateAppSpecDocument(yaml, { mode: 'data-repository' })` (exported from `packages/agent/src/works-config/index.ts`
  by APW-03 T7); every `env` entry with `secret: true` has `generate`, `from`, `template` or `prompt` and no
  `value`; no env `value` equal to the example-file value of a secret-classified variable (the job reads example env
  files from the writer checkout, never from the run); `APP_PROVISION_PRESERVED_SPEC_FIELDS` deep-equal to base;
  overlay Dockerfile `FROM` lines pinned (no `latest`, no untagged); every web component has ≥ 1 smoke entry and every
  component with a `port` has readiness and liveness probes; `cron` entries have `authEnv` naming a generated env;
  `checks` ≤ 5. Returns `{ ok, violations: Array<{ code, path?, variable? }> }` — never values.
- **Task finalize, not agent tools (R-17).** Both calls below run in the worker, outside the sandbox, on the Task's own
  finalize path (`TaskWorkspaceService` → `WorkspaceFacadeService.finalize` / `openPullRequestForBranch`). They are not
  agent tool calls, so the Agent's `publish.external` rung never holds them; the agent `commitToRepo` /
  `openPullRequest` tools stay denied (§7.4) and the APW-08 P0 tool fix still ships for other callers.
- Writer: `TaskWorkspaceService.pushProvisioningChanges({ task, userId, files })` **(new, additive)** — `provisionForRun`
  semantics for the branch, writes files, `finalize({ push: true })`, `simulateMerge`; conflict → rebase once by
  re-provisioning from the new base and re-writing the same files; returns `{ headSha }`.
- PR: `TaskWorkspaceService.openProvisioningPullRequest({ task, userId, title, body })` **(new, additive)** — calls
  the existing private `openPullRequestForBranch` with two new optional args `transitionToReview: false`,
  `attemptAgentMerge: false`; existing callers pass nothing and behave identically. On `succeeded` the job transitions
  the Task to `in_review` through `TaskTransitionService`.
- Evidence comments via `GitFacadeService.createPullRequestComment`, composed by `AppProvisionEvidenceRenderer`
  **(new, pure)**, then `redactSecrets`, truncated to 60,000 chars.

### 7.7 Questions

The job composes the question (not the model), so the subject, options and translations are deterministic:
`InboxService.askHuman(userId, { question: t(subjectKey, params), options: fixedOptions(reason), context }, { agentId, agentRunId })`.
`context` is the Agent's last `question.context` or failing-step summary, redacted, ≤ 2,000 chars, labelled
"written by the agent". Option ids are stable (`retry`, `optional`, `verify-on-cluster`, `accept-build-only`,
`raise-cap`, `choose:<n>`, `stop`); the answer is mapped to a row patch before `answered` resumes the run.

### 7.8 Chat

`AppProvisionChatNotifier` **(new)** posts milestone messages as the Agent via
`ConversationMessageService.appendAgentMessage` into the owner's most recent conversation with
`contextType: 'work', contextId: workId`, creating one titled with the Work name when none exists; ≤ 12 per
provisioning (`chatMessagesPosted`); message bodies from i18n keys in the owner's locale.

---

## 8. Cross-epic contracts consumed

| From   | What                                                                                                                                                                                                                                                                                                                                                                                                                        | Used for                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| APW-01 | `Work.kind = 'app'`, `sourceRepository.type` / `upstream`; creation hook calls `AppProvisioningService.start({ trigger: 'auto-create' })` when no Blueprint and no valid spec                                                                                                                                                                                                                                               | FR-1                        |
| APW-02 | `app.fork.ready` / `app.fork.timeout`; `app.upstream.synced` with the synced range                                                                                                                                                                                                                                                                                                                                          | repository step; FR-51      |
| APW-03 | App spec schema + `validateAppSpecDocument(yaml, { mode })` (pure) and `AppSpecService.validateDraft(workId, text)`; `POST /api/works/:id/app-spec/validate`; Blueprint resolution result; license class on `WorkAppSpecState`; `scanLicenseHeaders` + `AppLicenseService.recordEvidence`                                                                                                                                   | guard, validate step, FR-53 |
| APW-05 | `IBuildPlugin.startBuild({ ref, sha, mode: 'verify', verification })`, `getBuild` → status, `logsUrl`, `imageDigest`, `durationMinutes`, `verification` result (runner boot + smoke); `supportedStrategies` (for `auto`) — **accepted, R-10; implemented by APW-05's tasks**                                                                                                                                                | build + runner boot; brief  |
| APW-06 | `AppRenderInput.purpose: 'verification'` + `ttlMinutes` for `IDeploymentPlugin.deployApp`, `getAppStatus`, `destroyApp`, `checkAppCluster`; the `app-cluster-op` job on the isolated worker (production refuses cluster jobs until `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED` is set); `WorkAppRuntimeState` target `your-cluster`; smoke runner (no redirects followed) — **accepted, R-10; implemented by APW-06's tasks** | cluster boot + smoke        |
| APW-07 | `AppRuntimeEnvSource` ephemeral mode (generated + derived values in memory, no `WorkAppEnvValue` write) — **accepted, R-10; implemented by APW-07's tasks**; in-namespace and runner dependency containers without persistent volumes                                                                                                                                                                                       | FR-33, ACC-04-23            |
| APW-13 | Fixture repositories (incl. the prompt-injection fixture in the e2e upstream organization), `EVER_WORKS_E2E_FAKES` fake GitHub, the golden-path acceptance run; the nightly lane step that runs §11.3's live isolation spec                                                                                                                                                                                                 | ACC-04-05, 06, 10…15, 34    |

**CONTRACTS.md edits in this PR** (additive): §1 `spec.provisioning.autoReprovision`; §2 `WorkAppProvisioning`; §3
build `verification` option and deploy `purpose: 'verification'`; §4 three routes; §5 `app-provision-sweep`; §6
`app.provision.attempted`, `app.provision.blueprint_suggested`; §7 two cap env vars.

---

## 9. i18n

Keys under `dashboard.workDetail.appProvisioning` in `apps/web/messages/en.json`, mirrored into the 20 sibling
locale files. Leaves are camelCase tokens with no `.`. Listing as nested paths:

```
title "Provisioning" · attemptCounter "Attempt {n} of {budget}" · spent "Spent so far: {tokens} tokens · {minutes} runner minutes" · receipts "Receipts"
steps.repository "Waiting for the repository" · steps.analysis "Studying the repository" · steps.proposal "Writing the App spec"
steps.validate "Checking the App spec" · steps.build "Building" · steps.boot "Starting it up" · steps.smoke "Smoke tests" · steps.evidence "Ready for your review"
stepState.pending "Not started" · stepState.running "In progress" · stepState.passed "Passed" · stepState.failed "Failed" · stepState.blocked "Blocked" · stepState.skipped "Skipped"
headline.notStarted · headline.queued · headline.running · headline.needsInput · headline.succeeded · headline.mergedVerified
headline.mergedUnverified · headline.failed · headline.cancelled · headline.noIsolatedRuntime · headline.upstreamBroke   (copy: spec §6)
reason.noIsolatedRuntime … reason.verificationInfrastructure   (10 keys, copy: spec §6)
actions.provision "Provision" · actions.reprovision "Re-provision" · actions.cancel "Cancel" · actions.answer "Answer in My Decisions"
actions.openPullRequest "Open pull request" · actions.viewReport "View report" · actions.suggest "Suggest as App Blueprint" · actions.setUp "Set one up"
reprovisionDialog.title · .body · .caps · .activeWarning · .noteLabel · .confirm   (copy: spec §6)
suggestDialog.title · .body · .consent · .submit · suggested "Suggested — thank you. Maintainers review suggestions by hand."
targetCluster "On your cluster" · targetRunner "In the build runner"
stepNote.waitPlatform · stepNote.waitAgent · stepNote.waitWorkspace   (R-17 waits; copy: spec §6)
question.subject.<reason> (9 keys, incl. safetyRail) · question.option.<id> (7 keys) · question.reminder "Still waiting on your answer about {repo}."
chat.started · chat.proposed · chat.attemptRed · chat.succeeded · chat.needsInput · chat.failed   (copy: spec §6)
evidence.* (comment headings: attempt, step, verdict, duration, buildLog, imageDigest, target, smoke, spend)
```

Evidence comments and chat messages render in the provisioning owner's locale at write time.

---

## 10. Telemetry and failure modes

### 10.1 Events (PostHog through the monitoring package — counters and ids only)

| Event                            | Properties                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `app.provision.started`          | `{ provisioningId, trigger }`                                                                            |
| `app.provision.attempt_finished` | `{ provisioningId, n, verdict, failedStep, targetKind, durationMs }`                                     |
| `app.provision.question_asked`   | `{ provisioningId, reason }`                                                                             |
| `app.provision.finished`         | `{ provisioningId, status, failureReason, attempts, questions, tokens, runnerMinutes, detectionSource }` |
| `app.provision.suggested`        | `{ provisioningId }`                                                                                     |
| `app.provision.guard_rejected`   | `{ provisioningId, codes: string[] }` — violation codes only                                             |

Never: repository names, file paths, env names, question text, report text.

### 10.2 Failure modes

| Failure                                     | Behaviour                                                           | Why                                                   |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Run ends without a `provision-output` block | Red attempt `no-output`; resume once with the contract restated     | The model forgot the contract; one reminder is cheap. |
| Guard throws                                | Attempt `infra`, retry; never pushes                                | A guard that cannot run must not pass anything.       |
| Push rejected (branch protection)           | `failed/verification-infrastructure` with the provider message key  | Nothing to iterate on.                                |
| Build plugin not configured                 | Readiness `buildCapability: false`; start refused                   | Fail before spending tokens.                          |
| Cluster namespace create refused (RBAC)     | Infra verdict; this attempt falls back to runner                    | User cluster permissions are not a code problem.      |
| Destroy of verification namespace fails     | Sweeper retries every 15 min; card note after 3 failures            | Never leave a silent leak.                            |
| Inbox answer arrives after cancel           | Ignored (row not `needs_input`); answer recorded on the item        | Cancel is final.                                      |
| Two workers advance the same row            | Lease CAS; loser exits                                              | One effect set per event.                             |
| Effect replay after crash                   | Idempotency key `(provisioningId, attempt, effect)` in `stepStates` | Re-dispatch safe.                                     |
| PR comment fails                            | Logged; evidence still on run + card                                | Evidence must not fail verification.                  |
| Agent widened its grants between runs       | Dispatch refused; readiness false; card note                        | Defences are re-asserted, not assumed.                |

---

## 11. Test plan

### 11.1 Unit (Jest, agent package)

| File **(new)**                                                                            | Covers                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/src/app-provisioning/__tests__/provision-output.guard.spec.ts`            | Every violation code: path escape, `.github/**`, lockfile, > 12 files, > 3,000 lines, > 128 KB, literal secret, example-value reuse, preserved-field change, unpinned `FROM`, missing smoke/probes, cron without auth; violations never contain values.                                                                                                                                                      |
| `packages/agent/src/app-provisioning/__tests__/provision-output.schema.spec.ts`           | Last-block selection, size cap, strict unknown keys.                                                                                                                                                                                                                                                                                                                                                         |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning-step-runner.spec.ts`      | Table test over §2.5 × events; attempt CAS; fingerprint repeat → ask; infra retries do not consume attempts; ceilings (3 questions, 9 attempts); caps refuse dispatch; R-17: parked `kill-switch` / `agent-paused` / `workspace-paused` / `scope-paused` runs are waits (no attempt, no infra retry, `activeMs` frozen) and every other safety `reasonCode` ends in `needs_input` with reason `safety-rail`. |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts`          | Start dedupe; restart cancels; per-user 3 / per-org 10 queueing; readiness flags; suggestion eligibility and bundle scrubbing.                                                                                                                                                                                                                                                                               |
| `packages/agent/src/app-provisioning/__tests__/app-provision-evidence.renderer.spec.ts`   | Comment shape, truncation at 60,000, redaction, no env values.                                                                                                                                                                                                                                                                                                                                               |
| `packages/agent/src/app-provisioning/__tests__/app-provision-prompt.builder.spec.ts`      | Fences around instruction files, note and evidence; injection strings stay inside fences.                                                                                                                                                                                                                                                                                                                    |
| `packages/agent/src/app-provisioning/__tests__/app-provisioner-agent.resolver.spec.ts`    | Create once, reuse; grants re-asserted; widened grants refuse dispatch; skill re-install once.                                                                                                                                                                                                                                                                                                               |
| `packages/agent/src/agents/__tests__/agent-templates.repo-template.spec.ts`               | `createFromRepoTemplate` allow-list, schema-required keys, HTML strip, SOUL write.                                                                                                                                                                                                                                                                                                                           |
| `packages/agent/src/tasks-domain/__tests__/task-workspace.provisioning.spec.ts`           | Push-only and PR-without-review variants; existing `finalizeRun` golden behaviour unchanged.                                                                                                                                                                                                                                                                                                                 |
| `packages/tasks/src/__tests__/agent-task-execute.provisioning-branch.spec.ts`             | Provisioning Tasks skip workspace/gate and the default post-run finalize and notify; other Tasks unchanged.                                                                                                                                                                                                                                                                                                  |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.auto-start.spec.ts`       | APW-01 creation-service double: no Blueprint + no valid spec starts within 60 s of readiness (Task, row, `app.provision.started`); a matched Blueprint or valid spec starts nothing.                                                                                                                                                                                                                         |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.verification-env.spec.ts` | Runner and cluster attempts request APW-07's ephemeral mode; a `WorkAppEnvValue` repository spy records zero writes across red → green (ACC-04-23).                                                                                                                                                                                                                                                          |
| `packages/agent/src/app-provisioning/__tests__/app-provision-chat.notifier.spec.ts`       | Milestones posted in the Work thread (created when absent), never more than 12 per provisioning (ACC-04-28).                                                                                                                                                                                                                                                                                                 |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.finalize-path.spec.ts`    | With a `publish` rung of `ask`, push + PR go through `TaskWorkspaceService` finalize with no held action; `commitToRepo` / `openPullRequest` refused for the run (ACC-04-37).                                                                                                                                                                                                                                |

### 11.2 Controller specs (`apps/api`)

`apps/api/src/works/app-provisioning.controller.spec.ts` **(new)**: 202 within the handler (no await on the job);
409/422 codes; cross-scope 404 on all five routes; throttle metadata; viewer receives `canEdit: false`.

### 11.3 Isolation checks (P1 ship gate, run against a real sandbox in the nightly lane)

R-22: nothing lives under `apps/api/test/` (outside every Jest root). The check has two halves, both in runnable roots:

- **Unit, every PR** — `packages/agent/src/app-provisioning/__tests__/app-provision-sandbox.spec.ts` (the pre-resolved
  environment: `networkingMode: 'limited'`, the frozen host list with no IP literal or internal suffix, no env files,
  one tokenless `attachedRepos` entry) and
  `packages/plugins/claude-managed-agent/src/claude-managed-agent.plugin.runtime-environment.spec.ts` (that environment
  becomes an enforced `limited` sandbox policy).
- **Live, nightly** — `packages/plugins/claude-managed-agent/src/provision-sandbox-isolation.live.spec.ts` **(new,
  Vitest, inside the plugin's `src/**/\*.spec.ts`include)**:`describe.runIf(process.env.APW_E2E_LIVE === '1')`, so the
PR lane skips it. It opens a real managed session with the §7.3 environment and a probe script (no model turn): the
platform API origin from `APW_E2E_ALLOWED_BASE_URLS`, an RFC1918 address, `169.254.169.254`and an unlisted public host
must fail;`github.com`and`registry.npmjs.org`must succeed;`env`names and`git config --list`pass through`scanForSecrets`with zero matches (ACC-04-05/06). A second case with`networkingMode: 'unrestricted'`must see the
unlisted host succeed — the known-bad control that proves the probe can fail. Run by the nightly lane as`APW_E2E_LIVE=1 pnpm --filter @ever-works/claude-managed-agent-plugin test -- provision-sandbox-isolation.live`
  (lane step requested from APW-13).

### 11.4 Skill evals

`ever-works/agents/eval/app-provisioner.yml` (catalog repo, schema `eval.schema.json`) with 8 fixture repositories
maintained under APW-13: app-spec present, compose, Dockerfile, Helm, descriptor-hint, zero-config `auto` (source code
only — expected `auto` when the brief lists it, an overlay Dockerfile when it does not), bootstrap-risk +
swallowed-migration, cron + fixed-length key. Expected: detection source, dependency set, env classifications, jobs,
cron, probes (ACC-04-10…15).

### 11.5 e2e (Playwright, `apps/web/e2e/`)

| File **(new)**                               | Golden path                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `app-provisioning-card.spec.ts`              | Mocked API: every headline state, 8 step rows, attempt counter, polling stops when terminal, viewer hides actions. |
| `app-provisioning-reprovision.spec.ts`       | Confirm dialog caps; active-provisioning variant; note field limit.                                                |
| `app-provisioning-needs-input.spec.ts`       | Amber state → My Decisions → answer option → card back to running.                                                 |
| `app-provisioning-suggest-blueprint.spec.ts` | Eligibility gating; consent gates submit; suggested state.                                                         |
| `app-provisioning-a11y.spec.ts`              | axe on card and dialogs; state announced as text.                                                                  |

Web unit (Vitest): `apps/web/src/components/works/detail/overview/AppProvisioningCard.unit.spec.tsx`,
`AppReprovisionDialog.unit.spec.tsx`, `AppBlueprintSuggestDialog.unit.spec.tsx`, the chat tool spec
`apps/web/src/lib/ai/tools/work.tools.unit.spec.ts`, and the message catalogue guard
`apps/web/src/components/works/detail/overview/app-provisioning-messages.unit.spec.ts` (every
`dashboard.workDetail.appProvisioning` key the card, dialogs, questions, chat milestones and evidence read exists in all
21 locales, camelCase leaves without `.`, `createTranslator` round trip — ACC-04-33).

End-to-end journeys ACC-04-01…04, ACC-04-16…31 and ACC-04-35…37 are wired into [ACCEPTANCE.md](../ACCEPTANCE.md) under APW-04 against
the APW-13 fixture app.

---

## 12. Phasing

### P0 — Prerequisites (small, independently shippable)

`enforcesRuntimeNetworking` flag; `createFromRepoTemplate` (allow-list of one); worker provisioning branch behind a
row lookup (no rows exist yet, so inert); sandbox isolation live spec in the plugin package (§11.3).

### P1 — Provision, verify in the runner, ask (Wave 1)

Entity + migration; contracts; service; dispatcher + job + sweeper (items 2–6); Agent/Skill/grants/Environment; guard;
writer + PR variants; validate + build + **runner** boot + smoke; evidence; iterate; questions; caps; card, dialogs,
chat, Activity, telemetry, i18n; catalog PRs for the template and the Skill. **Depends on** APW-01 P1, APW-03 P1,
APW-05 P1 (with `verification`), APW-07 P1 (`AppRuntimeEnvSource` ephemeral mode).

### P2 — Verify on your cluster; upstream breakage (Wave 1)

Cluster verification namespace (APW-06 P1 `purpose: 'verification'`), target selection, sweeper item 1, upstream-broke
banner and manual re-provision with range (APW-02 P1).

### P3 — Blueprint suggestions; opt-in automatic re-provision (Wave 2)

Suggestion endpoint + admin list + bundle; `spec.provisioning.autoReprovision` handling with 1-per-sync / 2-per-7-days
limits; per-Organization cap override.

---

## 13. Constitution compliance checklist

- [x] **I — Plugin-first.** No new integration: builds and runtimes arrive through APW-05/06 capabilities; the pipeline is
      chosen by capability flag.
- [x] **II — No hard-coded plugin ids.** `enforcesRuntimeNetworking` is read through the pipeline facade; the only
      template slug constant lives in the allow-list of the instantiation path, which is catalog data selection, not a
      plugin id.
- [x] **III — Source of truth in repos.** The App spec lands by PR in the data repository; the table is derived state;
      the automatic re-provision opt-in lives in the App spec.
- [x] **IV — Job runtime.** `app-provision` and `app-provision-sweep` via `APP_PROVISION_DISPATCHER`; endpoints 202.
- [x] **V — Forward-only migration.** One new table, six indexes, `down()` drops only those.
- [x] **VI — Tests first.** §11 lists unit, controller, isolation, eval and Playwright specs as tasks.
- [x] **VII — Secrets.** No secret in the sandbox; guard + redaction on every text that leaves a run; Activity and
      telemetry carry names and counts only.
- [x] **VIII — Plugin counts.** No plugin added.
- [x] **IX — Behaviour-first.** `spec.md` has no class or file names.
- [x] **X — Compatibility.** `finalizeRun` and `openPullRequestForBranch` keep their behaviour for existing callers; new
      pipeline field optional.
- [x] **Program rule 9.** Repository content, instruction files and build output are fenced as untrusted; nothing from the
      repository executes on platform infrastructure outside a sandbox or the user's own runner/cluster.
- [x] **Program rule 12.** Runs and Builds carry receipts; caps enforced before spend.

### Known gaps carried forward

- **Single isolated runtime.** Until a second pipeline enforces Environment networking, provisioning is only available
  where the managed-agent pipeline is configured. Fleet nodes are excluded in P1 (open question in spec §9).
- **Private copies** depend on the managed repository mount keeping its read token out of the sandbox shell; if T6
  cannot prove that, P1 refuses private copies with readiness `isolatedRuntime: false` for them.
- **Draft pull requests** are not used: the provider contract has no ready-for-review operation. The Task state and the
  card carry "verifying"; merging early is allowed and recorded as unverified.
- **In-run token cap** relies on the pipeline's USD session budget; token-exact enforcement happens between runs.
