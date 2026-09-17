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
[CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)

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
| Worker         | `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts`                                                                                                                                                                            | The Task run: resolves checks → `TaskWorkspaceService.provisionForRun` → optional L0 pre-check → pipeline run → red→iterate gate loop bounded by `resolveMaxGateAttempts` → `finalizeRun`. **The gate runs before the push.** A Task run reaches **no pipeline**: `runner.execute(...)` (`agent-task-execute.task.ts:607`) enters `AgentRunService`'s in-process tool loop over the AI facade, so `runtimeEnvironment` and `attachedRepos` never arrive on this path — §2.6 adds the session runner that does.                                                                       |
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
9. **No execution path puts a Task run inside the restricted-network sandbox.** `limited` networking becomes an
   enforced policy only in the managed-agent plugin's own session machinery
   (`packages/plugins/claude-managed-agent/src/utils/runtime-environment.ts:45-52`), and that machinery is reached
   only through `IPipelinePlugin.execute(work, request, existing, options)`, whose `options.runtimeEnvironment` /
   `options.attachedRepos` (`pipeline-plugin.interface.ts:97,106`) are set by `FullPipelineExecutorService`
   (`full-pipeline-executor.service.ts:192,253-265`) — never by the Task-run worker. The plugin already publishes a
   programmatic session entry point (`runSessions`, `claude-managed-agent.plugin.ts:347-408`, registered as
   `CMA_FAN_OUT_CAPABILITY`, `types.ts:379`), but it resolves its control plane with **no** runtime Environment
   (`:374`) and carries no per-session system prompt, so it cannot yet be the provisioning runtime. §2.6 adds the
   runner, T48 builds it.

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
worker, and the writer checkout lives in the worker's workspace provider. The analysis run itself is opened by §2.6's
session runner — the one caller that passes the pre-resolved Environment and the repository mount into a pipeline.

### 2.2 Two workspaces, on purpose

| Workspace            | Where                                                                                                    | Holds credentials | Runs repository code | Network                         |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- | -------------------- | ------------------------------- |
| **Analysis sandbox** | The pipeline's managed sandbox; repository mounted from `attachedRepos` at the Task branch (or base ref) | No                | May (reads, parsers) | `limited`: §7.3 allow-list only |
| **Writer checkout**  | `workspace` capability in the worker (`sandbox-workspace`)                                               | Per-command token | Never (git only)     | Git host only (worker default)  |

The analysis run returns files **as data** (§3.3). The job validates them, writes them into the writer checkout, and
pushes.

- **Public data repositories mount tokenlessly.** `AttachedRepoResource.url` is token-free by contract
  (`pipeline-plugin.interface.ts:41`) and the managed session's `github_repository` resource carries no credential.
- **In Wave 1 P1 a private data repository is not provisioned** — that is a private copy (`repositoryMode:
'private-copy'`) or a Link whose provider visibility, read through APW-02's `IGitProviderPlugin.getRepository`, is
  `private` or `internal`. Readiness gains `publicRepository: false` (§4); `start` refuses with 422
  `provisioningUnavailable` and `missing: ['publicRepository']`; no Run, Task, branch or pull request is created and no
  token is minted (FR-63, ACC-04-40). The card shows the private-repository state (spec §6).
- `GitFacadeService.getInstallationTokenForOwner` (`git.facade.ts:1783-1790`) is **not** used on this path: it looks up
  the active installation for an owner login and calls `createGitHubAppInstallationToken(installationId)` (`:1816`) with
  no repository ids and no permissions — a full, un-narrowed installation token.
- **A later wave may lift the refusal** — additively, and only after both halves exist: a narrowed mint (repository ids
  plus `contents: read`, passed through the options argument of `requestGitHubAppInstallationAccessTokenDetails` the way
  `apps/api/src/fleet/fleet-push-credential.service.ts` does), and a token-carrying mount field in the pipeline
  contract whose token is proven absent from the sandbox shell by a live probe in T4. Until then the refusal above is
  the behaviour, and T14's test asserts no token-mint call happens at all.

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
the default post-run `finalizeRun`; it hands the run to §2.6's session runner (`AppProvisionSessionRunner.run(runId)`)
rather than to `AgentRunService.execute` — that runner is the only place the provisioning's pre-resolved
`runtimeEnvironment` and its `attachedRepos` reach a pipeline — and on completion calls
`AppProvisioningService.notify({ event: 'run-finished', runId })`. Finalize is **deferred to the job**:
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

The cluster branch is executed by APW-06 T60's `AppVerificationTargetService`
(`packages/agent/src/app-runtime/app-verification-target.service.ts`); APW-04's own
`app-provision-verification-target.service.ts` **(new, T34)** is the selector and TTL bookkeeper that calls it, so the
namespace scheme (`<ns>-v<attempt>`) and its lifecycle have exactly one implementation.

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

**Step outcomes.** §2.3's diagram is entered per event; the step runner's verdict decides the next row state. Every
outcome the output contract (§3.3) can produce has exactly one row here — `no-change`, `not-runnable` and `question` are
the three the guard-red/green branches of §2.3 do not mention:

| Outcome (step)            | Row patch                                                                                                                 | Step shown                                                                                | Effect                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-change` (proposal)    | `status: succeeded`, `prNumber: null`, `verified: true`, `finishedAt: now`; `headSha = baseSha`                           | `evidence` `passed`, note `noteNoChange`                                                  | The **base** head is built in verify mode (so the runner minutes and the build evidence are real); no push, no pull request, no Task `in_review`; `app.provision.succeeded` |
| `not-runnable` (analysis) | `status: failed`, `failureReason: not-runnable`, `finishedAt: now`                                                        | `analysis` `failed`, note `noteNotRunnable`                                               | The report explains why; no push, no pull request, no build; `app.provision.failed`                                                                                         |
| `question` (any step)     | `status: needs_input`, `questionReason`, `questionParams`, `openInboxItemId`, `questionAskedAt`; `attemptsUsed` unchanged | the step stays `running` for a cap question, otherwise `blocked`, note `noteQuestion`     | §7.7 composes and files the question; asking never consumes an attempt; `app.provision.needs_input`                                                                         |
| `blocked` (boot, FR-33)   | `status: needs_input`, `questionReason: missing-required-value`, `questionParams.variable` (name only — never a value)    | `boot` `blocked`, note `noteMissingValue`                                                 | Same as `question`; the App env page is linked                                                                                                                              |
| parked (R-17 wait)        | `status` unchanged, `parkedReason` / `parkedAt` set                                                                       | current step `running`, note `waitPlatform` / `waitAgent` / `waitWorkspace` / `waitScope` | No attempt, no infra retry, `activeMs` frozen; re-tick every 5 min                                                                                                          |

**Question reasons → options → effect.** Option ids are stable and every reason maps to at most `optionsMax` (4) of
them; the answer is mapped to a row patch before `answered` resumes the run (§7.7). `verify-on-cluster` is offered only
when the App Work's deploy target is **Your cluster** and §2.4 reached the cluster branch — in P1 that row does not
exist, so the option is omitted and the table is at most three options:

| Reason                   | Options (ids)                                                         | Row patch the answer applies                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempts-spent`         | `retry` · `optional` · `stop`                                         | `retry`: `attemptBudget += attemptsPerAnswer` and resume. `optional`: the named variable becomes optional in the next brief. `stop`: `failed/could-not-verify`                            |
| `repeated-failure`       | `retry` · `optional` · `stop`                                         | as above; `questionParams.attempts` names the two matching attempts                                                                                                                       |
| `missing-required-value` | `retry` · `optional` · `stop`                                         | `retry`: resume (the value was set on the App env page). `optional`: mark it optional and resume                                                                                          |
| `runner-capacity`        | `verify-on-cluster` · `accept-build-only` · `stop`                    | `verify-on-cluster`: `verificationTargetKind: 'cluster'`, boot step re-dispatched. `accept-build-only`: `status: succeeded`, `verified: false`, note `noteBuildOnly`. `stop`: `cancelled` |
| `token-cap`              | `raise-cap` · `stop`                                                  | `raise-cap`: §6.4's approval proposal; approval patches `tokenCap` and dispatches `answered`                                                                                              |
| `runner-minute-cap`      | `raise-cap` · `stop`                                                  | as above, `runnerMinuteCap`                                                                                                                                                               |
| `multiple-apps`          | `choose:1` … `choose:4` (1-based over `question.candidates`) · `stop` | `choose:<n>`: the chosen path goes into the next brief and the run resumes                                                                                                                |
| `agent-asked`            | `retry` · `stop`                                                      | `retry`: resume with the answer appended to the brief                                                                                                                                     |
| `safety-rail` (R-17)     | `retry` · `stop`                                                      | `retry`: resume once the rail's cause is gone; `questionParams.reasonCode` is the gate's `SafetyReasonCode`                                                                               |

### 2.6 Provisioning session runner (T48)

**Where the sandbox actually is.** The only code that turns `runtimeEnvironment.networkingMode: 'limited'` into an
enforced policy is `packages/plugins/claude-managed-agent/src/utils/runtime-environment.ts:45-52`
(`{ type: 'limited', allowed_hosts, allow_package_managers, allow_mcp_servers: false }`), reached only from that
plugin's own session machinery. A Task run never gets there (§1.2 blocker 9), so a provisioning Task on the default path
would analyse the repository in the in-process tool loop — no sandbox, no network policy. This section adds the path
that does reach it, and leaves the default path byte-identical for every other Task.

`IPipelinePlugin` gains one more **optional** method (additive; the CONTRACTS §3 row is reported in this PR's CONTRACTS
edit):

```ts
/**
 * Sandbox session runner — a pipeline that declares `enforcesRuntimeNetworking`
 * opens ONE restricted session for a caller that is not a Work generation
 * (the App Provisioner, APW-04). Optional: existing pipelines are unaffected.
 */
runSandboxSession?(input: SandboxSessionInput, signal?: AbortSignal): Promise<SandboxSessionResult>;
```

```ts
export interface SandboxSessionInput {
	userId: string;
	workId: string; // settings scope only — never a generation target
	system: string; // the Skill body (§7.2)
	prompt: string; // the brief (§7.5), already fenced
	runtimeEnvironment: RuntimeEnvironmentData; // §7.3, pre-resolved
	attachedRepos?: readonly AttachedRepoResource[]; // one entry, mountDir 'repo'
	budgetUsd?: number; // §6.4's remaining token allowance
	timeoutMs?: number; // analysisRunMs / iterateRunMs (FR-14)
	label?: string; // session title
}
export interface SandboxSessionResult {
	status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget-exhausted';
	failureCode?: 'requiresAction' | 'noAgentMessage' | 'provider'; // only with 'failed'
	finalText: string | null; // last assistant message; the job takes the last provision-output block
	usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
	sessionId?: string;
}
```

Contract note (additive — it narrows nothing in `execute`): only a plugin that sets `enforcesRuntimeNetworking` may
implement `runSandboxSession`, and a sandbox session **never pauses for a custom tool**, so a provider
`requires_action` returns `failed` with `requiresAction` instead of waiting. The managed-agent implementation reuses
what the plugin already has — `resolveManagedAgentSettings` (`utils/pipeline-helpers.ts:100`), `ensureControlPlane`
(`utils/control-plane.ts:252`), `buildSessionResources` (`utils/session-resources.ts:62`), `createSession` with
`budgetUsd`, `sendUserMessage` / `waitForSessionIdle`, `extractAgentTranscript` (`utils/result-parser.ts:5`) and
`toManagedSessionTokenUsage` (`utils/usage-metrics.ts`) — and adds the three things it lacks today: the pre-resolved
Environment reaches the control plane (today `runSessions` passes `null`, `claude-managed-agent.plugin.ts:374`), the
session runs on an **ephemeral** agent + environment so a restricted per-run policy can never be written onto the
persistent control plane, and the session's `system` is the Skill body.

`AppProvisionSessionRunner` **(new, `packages/agent/src/app-provisioning/app-provision-session.runner.ts`, T48)**:

- resolves the plugin by capability (has the flag **and** the method) through the pipeline facade — never a plugin id
  (Constitution II);
- is called by the worker's provisioning branch (T3) **instead of** `runner.execute(...)`, and never falls back to it:
  a provisioning Task with no capable plugin is refused before any spend (readiness `isolatedRuntime: false`, S10),
  rather than silently analysed in the in-process loop;
- writes the terminal `AgentRun` row: status, `totalTokens` from `usage`, `costCents`, and a `redactSecrets`-ed
  `summary` of at most 2,000 characters;
- stores the last `provision-output` block in `WorkAppProvisioning.lastRunOutput` (§3.1, ≤ 512 KB); the job clears it
  once §7.6's guard has read it;
- calls `notify({ event: 'run-finished', runId })`;
- treats an **iterate** as a new run dispatched through the assign-task path with the evidence in its brief (§7.5) —
  never `RunSteeringService.resume` — so every iterate is admitted, capped and counted like any other run (R-17, §6.4).

The session holds no platform tool and no credential, so no tool call inside it passes `SAFETY_GATE` — there is nothing
to gate. §7.4's platform-tool descriptors stay registered for the run host (they are what the in-host paths use) and are
simply unreachable from the session: the session is not the in-process tool loop, and the environment pins
`allow_mcp_servers: false`.

---

## 3. Data model

**Workspace backup (Resolution R-25).** `WorkAppProvisioning` exports as `data/works/app-provisionings.jsonl` through the parent Work ids (`tokenCap` reviewed as benign); `Organization.appProvisionCaps` rides the existing organizations file ([tasks](./tasks.md) T47).

### 3.1 `work_app_provisionings` (new entity `WorkAppProvisioning`)

`packages/agent/src/entities/work-app-provisioning.entity.ts` **(new)**. Derived state only (Constitution III).

| Column                                                                     | Type                                                                            | Notes                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                       | `uuid` PK                                                                       |                                                                                                                                                                                                                                                                                               |
| `workId`                                                                   | `uuid NOT NULL`                                                                 | `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`                                                                                                                                                                                                                                             |
| `userId`                                                                   | `uuid NOT NULL`                                                                 | starter; question recipient (owner for automatic starts)                                                                                                                                                                                                                                      |
| `tenantId`, `organizationId`                                               | `uuid NULL`                                                                     | scope stamps, no relation                                                                                                                                                                                                                                                                     |
| `taskId`, `agentId`                                                        | `uuid NULL`                                                                     | no FK (entity-cycle rule)                                                                                                                                                                                                                                                                     |
| `trigger`                                                                  | `varchar(24)`                                                                   | `auto-create` · `manual` · `chat` · `upstream-smoke` · `auto-upstream-smoke`                                                                                                                                                                                                                  |
| `status`                                                                   | `varchar(16)`                                                                   | `queued` · `running` · `needs_input` · `succeeded` · `merged` · `failed` · `cancelled`                                                                                                                                                                                                        |
| `queuedReason`                                                             | `varchar(24) NULL`                                                              | `user-limit` · `org-limit`                                                                                                                                                                                                                                                                    |
| `step`                                                                     | `varchar(16)`                                                                   | §2.5 step ids                                                                                                                                                                                                                                                                                 |
| `stepStates`                                                               | `simple-json`                                                                   | `Record<Step, { state, startedAt?, finishedAt?, noteKey?, noteParams? }>`                                                                                                                                                                                                                     |
| `detectionSource`                                                          | `varchar(24) NULL`                                                              | `app-spec` · `compose` · `dockerfile` · `helm` · `descriptor-hint` · `auto` (R-13)                                                                                                                                                                                                            |
| `verified`                                                                 | `boolean NULL`                                                                  | set on `merged`                                                                                                                                                                                                                                                                               |
| `failureReason`                                                            | `varchar(40) NULL`                                                              | spec §5.3 closed set                                                                                                                                                                                                                                                                          |
| `baseSha`, `headSha`                                                       | `varchar(64) NULL`                                                              |                                                                                                                                                                                                                                                                                               |
| `prNumber` / `prUrl`                                                       | `int NULL` / `varchar(512) NULL`                                                |                                                                                                                                                                                                                                                                                               |
| `attempts`                                                                 | `simple-json`                                                                   | `AppProvisioningAttempt[]`, ≤ 9 (§3.2)                                                                                                                                                                                                                                                        |
| `attemptBudget`, `attemptsUsed`, `questionsAsked`                          | `int NOT NULL`                                                                  | defaults 3 / 0 / 0; `attemptsUsed` advanced by compare-and-set                                                                                                                                                                                                                                |
| `openInboxItemId`, `questionAskedAt`, `questionRemindedAt`                 | `uuid NULL`, `timestamptz NULL` ×2                                              |                                                                                                                                                                                                                                                                                               |
| `questionReason`, `questionParams`                                         | `varchar(24) NULL`, `simple-json NULL`                                          | one of `APP_PROVISIONING_QUESTION_REASONS`; params carry names only (`variable`, `step`, `attempts`, `candidates`, `reasonCode`, `fingerprint`), ≤ 1 KB, `scanForSecrets`-ed, **never a value**; set with `openInboxItemId` in the same patch and cleared on `answered` or any terminal state |
| `tokensUsed`, `tokenCap`                                                   | `bigint NOT NULL`                                                               | cap default 3,000,000                                                                                                                                                                                                                                                                         |
| `runnerMinutesUsed`, `runnerMinuteCap`                                     | `int NOT NULL`                                                                  | cap default 240                                                                                                                                                                                                                                                                               |
| `activeMs`                                                                 | `bigint NOT NULL default 0`                                                     | accrues outside `needs_input` and while not parked; deadline 8 h                                                                                                                                                                                                                              |
| `parkedReason`, `parkedAt`                                                 | `varchar(24) NULL`, `timestamptz NULL`                                          | `kill-switch` · `agent-paused` · `workspace-paused` · `scope-paused` (R-17 waits)                                                                                                                                                                                                             |
| `runIds`, `buildIds`                                                       | `simple-json`                                                                   | ≤ 16 / ≤ 9                                                                                                                                                                                                                                                                                    |
| `lastRunOutput`                                                            | `text NULL` (`mediumtext` on MySQL/MariaDB)                                     | the last session's `provision-output` block, ≤ 512 KB; cleared once §7.6's guard has read it (§2.6)                                                                                                                                                                                           |
| `verificationTargetKind`, `verificationNamespace`, `verificationExpiresAt` | `varchar(16) NULL`, `varchar(63) NULL`, `timestamptz NULL`                      | sweeper input                                                                                                                                                                                                                                                                                 |
| `conversationId`, `chatMessagesPosted`                                     | `uuid NULL`, `int default 0`                                                    | ≤ 12                                                                                                                                                                                                                                                                                          |
| `note`                                                                     | `varchar(500) NULL`                                                             | "anything to tell the agent" (fenced as user input)                                                                                                                                                                                                                                           |
| `upstreamFromSha`, `upstreamToSha`                                         | `varchar(64) NULL`                                                              | upstream-smoke trigger range                                                                                                                                                                                                                                                                  |
| `suggestionState`, `suggestionUpstream`, `suggestedAt`, `suggestionBundle` | `varchar(16) NULL`, `varchar(200) NULL`, `timestamptz NULL`, `simple-json NULL` | bundle ≤ 256 KB                                                                                                                                                                                                                                                                               |
| `lease`, `leaseExpiresAt`                                                  | `varchar(36) NULL`, `timestamptz NULL`                                          | step executor CAS; lease 5 min                                                                                                                                                                                                                                                                |
| `startedAt`, `finishedAt`, `createdAt`, `updatedAt`                        | `timestamptz`                                                                   | `PortableDateColumn`                                                                                                                                                                                                                                                                          |

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
	/** Two starts of the same App Work inside this window yield one row (§4 "Start semantics"). */
	startDedupeMs: 10_000,
	analysisRunMs: 45 * 60_000,
	iterateRunMs: 30 * 60_000,
	forkWaitMs: 30 * 60_000,
	activeDeadlineMs: 8 * 3_600_000,
	/**
	 * Verification-Build reservation: `min(headSpec.build.resources.timeoutMinutes, buildMinutesMax)
	 * + runnerBootMinutesMax` — 90 minutes at the defaults, and the number §6.4 compares against the cap.
	 */
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

/** Singular aliases of the lists above — the names the views below (and every other epic) read. */
export type AppProvisioningStatus = (typeof APP_PROVISIONING_STATUSES)[number];
export type AppProvisioningStep = (typeof APP_PROVISIONING_STEPS)[number];
export type AppProvisioningStepState = (typeof APP_PROVISIONING_STEP_STATES)[number];
export type AppProvisioningFailureReason = (typeof APP_PROVISIONING_FAILURE_REASONS)[number];
export type AppProvisioningQuestionReason = (typeof APP_PROVISIONING_QUESTION_REASONS)[number];
export type AppProvisioningParkReason = (typeof APP_PROVISIONING_PARK_REASONS)[number];
export type AppProvisioningDetectionSource = (typeof APP_PROVISIONING_DETECTION_SOURCES)[number];
export type AppProvisioningTrigger = 'auto-create' | 'manual' | 'chat' | 'upstream-smoke' | 'auto-upstream-smoke';

/** §4's GET body — one place defines the shape the API, the card and the receipts all read. */
export interface AppProvisioningStepView {
	state: AppProvisioningStepState;
	startedAt: string | null;
	finishedAt: string | null;
	/** i18n leaf under `dashboard.workDetail.appProvisioning.stepNote` (e.g. `waitPlatform`). */
	noteKey: string | null;
	noteParams: Record<string, string | number> | null;
}
export interface AppProvisioningAttemptView {
	n: number;
	startedAt: string;
	finishedAt: string | null;
	verdict: AppProvisioningAttempt['verdict'];
	failedStep: AppProvisioningStep | null;
	targetKind: 'cluster' | 'runner' | null;
	buildId: string | null;
	imageDigest: string | null;
	logsUrl: string | null;
	smoke: AppProvisioningAttempt['smoke'] | null;
	tokens: number;
	runnerMinutes: number;
}
export interface AppProvisioningQuestionView {
	reason: AppProvisioningQuestionReason;
	/** names only: variable, step, attempts, candidates, reasonCode (never a value, §3.1). */
	params: Record<string, string | number>;
	askedAt: string;
	/** the Inbox item id — returned to the question's recipient only (§4). */
	inboxItemId: string | null;
}
export interface AppProvisioningView {
	id: string;
	workId: string;
	taskId: string | null;
	trigger: AppProvisioningTrigger;
	status: AppProvisioningStatus;
	queuedReason: 'user-limit' | 'org-limit' | null;
	step: AppProvisioningStep;
	stepStates: Record<AppProvisioningStep, AppProvisioningStepView>;
	parkedReason: AppProvisioningParkReason | null;
	detectionSource: AppProvisioningDetectionSource | null;
	attemptBudget: number;
	attemptsUsed: number;
	attempts: AppProvisioningAttemptView[];
	question: AppProvisioningQuestionView | null;
	failureReason: AppProvisioningFailureReason | null;
	verified: boolean | null;
	pullRequest: { number: number; url: string } | null;
	headSha: string | null;
	spend: { tokensUsed: number; tokenCap: number; runnerMinutesUsed: number; runnerMinuteCap: number };
	runIds: string[];
	buildIds: string[];
	verificationTargetKind: 'cluster' | 'runner' | null;
	suggestionState: string | null;
	suggestedAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	createdAt: string;
	updatedAt: string;
}
export type AppProvisioningSummaryView = Pick<
	AppProvisioningView,
	| 'id'
	| 'trigger'
	| 'status'
	| 'failureReason'
	| 'verified'
	| 'pullRequest'
	| 'attemptsUsed'
	| 'attemptBudget'
	| 'spend'
	| 'startedAt'
	| 'finishedAt'
>;
export interface AppProvisioningReadiness {
	isolatedRuntime: boolean;
	agentTemplate: boolean;
	buildCapability: boolean;
	clusterTarget: boolean;
	/** private copy or linked private/internal repository → false in Wave 1 P1 (§2.2, FR-63). */
	publicRepository: boolean;
}
export interface AppProvisioningResponse {
	active: AppProvisioningView | null;
	/** newest terminal row — drives the Succeeded / Merged / Failed / Cancelled headlines. */
	latest: AppProvisioningView | null;
	recent: AppProvisioningSummaryView[]; // ≤ 10
	readiness: AppProvisioningReadiness;
	upstreamSmokeBroken: { fromSha: string; toSha: string } | null;
	suggestionEligible: boolean;
	/** the caller may start, cancel or suggest (FR-56); false for a viewer (ACC-04-32). */
	canEdit: boolean;
}

/**
 * Reason and option ids are machine tokens; these maps turn each one into the
 * camelCase i18n leaf §9 declares, so no id is ever composed into a key. Same
 * shape as `ACTION_CATEGORY_I18N_KEY` (`packages/contracts/src/safety/action-category.types.ts`).
 * `choose:<n>` resolves by its `choose` prefix, with `n` as a param.
 */
export const APP_PROVISIONING_QUESTION_REASON_I18N_KEY = {
	'attempts-spent': 'attemptsSpent',
	'repeated-failure': 'repeatedFailure',
	'missing-required-value': 'missingRequiredValue',
	'runner-capacity': 'runnerCapacity',
	'token-cap': 'tokenCap',
	'runner-minute-cap': 'runnerMinuteCap',
	'multiple-apps': 'multipleApps',
	'agent-asked': 'agentAsked',
	'safety-rail': 'safetyRail'
} as const satisfies Record<AppProvisioningQuestionReason, string>;
export const APP_PROVISIONING_FAILURE_REASON_I18N_KEY = {
	'no-isolated-runtime': 'noIsolatedRuntime',
	'repository-not-ready': 'repositoryNotReady',
	'repository-too-large': 'repositoryTooLarge',
	'not-runnable': 'notRunnable',
	'token-cap': 'tokenCap',
	'runner-minute-cap': 'runnerMinuteCap',
	deadline: 'deadline',
	'could-not-verify': 'couldNotVerify',
	'no-answer': 'noAnswer',
	'verification-infrastructure': 'verificationInfrastructure',
	'private-repository': 'privateRepository'
} as const satisfies Record<AppProvisioningFailureReason, string>;
export const APP_PROVISIONING_QUEUED_REASON_I18N_KEY = {
	'user-limit': 'userLimit',
	'org-limit': 'orgLimit'
} as const;
export const APP_PROVISIONING_OPTION_I18N_KEY = {
	retry: 'retry',
	optional: 'optional',
	'verify-on-cluster': 'verifyOnCluster',
	'accept-build-only': 'acceptBuildOnly',
	'raise-cap': 'raiseCap',
	choose: 'choose',
	stop: 'stop'
} as const;
```

**Every date in these views is an ISO string** (`string`, never a `Date`), converted at the controller boundary.
**Never returned by `GET /provisioning`:** `userId`, `tenantId`, `organizationId`, `agentId`, `note`, `lease`,
`leaseExpiresAt`, `suggestionBundle`, `suggestionUpstream`, `conversationId`, `chatMessagesPosted`, `activeMs`,
`openInboxItemId` (except as `question.inboxItemId` to the question's recipient), `verificationNamespace`,
`verificationExpiresAt`, `baseSha`, `lastRunOutput`, `upstreamFromSha` / `upstreamToSha` (surfaced only through
`upstreamSmokeBroken`), and `attempts[].fingerprint` / `attempts[].commentId`. T6 pins the key set of each interface,
T23 asserts key-set equality against the response, and T25 renders from it alone.

**`baseSpecYaml` — what "preserved" is compared against (G04).** The guard's base is the **last valid applied spec**
(APW-03's `WorkAppSpecState` on the tracked branch) merged with APW-01's `sourceRepository` fields — never the raw head
file. So the injection fixture's pre-seeded `upstreamPullRequests.requireApproval: false` is not a base and the proposal
does not inherit it (ACC-NEG-05): when the head spec is absent or invalid the base is `{ source }` plus schema-safe
defaults (`upstreamPullRequests.requireApproval: true`, `display.protectedPaths` from the matched Blueprint or empty,
`provisioning.autoReprovision: false`). `preservedFieldChanged` still fires for any attempt to change a field the
platform owns, and removals from the two protected-path lists are reported (APW-03 `diffGuardedSpecBlocks`, §2A). T10
and T18 each carry a case for the invalid pre-seeded spec.

**Question copy lives in contracts (G09).** Reason ids, option ids and their params are structure; the English text the
platform writes is composed by a pure module,
`packages/contracts/src/apps/app-provisioning-copy.ts` **(new, R-1, T49)** — `appProvisionCopy.questionSubject(reason,
params)`, `.questionOptions(reason, params)`, `.chat.*`, `.evidence.*`, `.reminder` and `.reasonText(failureReason,
params)` — one exported constant per string, no I/O, no locale files at runtime. Its values are exactly the `en.json`
leaves of §9, so §9 remains the single source of the copy and T27 pins the two together. Stored Inbox, chat, reminder
and pull-request text is **English** (GitHub and the Inbox both store text, and APW-02 §8 sets the same rule for
Tasks); every headline, reason and label the **card** draws is rendered from keys in the viewer's locale (§9).

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

| Method | Path                                                                                | Body / response                                                                                                                                                                                                                                            | Throttle           |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `POST` | `/api/works/:id/provision` (CONTRACTS §4, 202)                                      | `{ restart?: boolean; note?: string (≤ 500) }` → `{ provisioningId, status, deduplicated }`                                                                                                                                                                | 10 / hour / user   |
| `GET`  | `/api/works/:id/provisioning` **(added to CONTRACTS §4)**                           | `AppProvisioningResponse` (§3.2): `active`, `latest`, `recent (≤ 10)`, `readiness: { isolatedRuntime, agentTemplate, buildCapability, clusterTarget, publicRepository }`, `upstreamSmokeBroken`, `suggestionEligible`, `canEdit` — read permission (FR-56) | default            |
| `POST` | `/api/works/:id/provision/cancel` **(added, 202)**                                  | → `{ provisioningId, status: 'cancelled' }`; idempotent                                                                                                                                                                                                    | 30 / minute        |
| `POST` | `/api/works/:id/provisioning/:provisioningId/blueprint-suggestion` **(added, 202)** | `{ consent: true }` → `{ suggestionState: 'queued' }`                                                                                                                                                                                                      | 5 / 30 days / user |
| `GET`  | `/api/admin/app-blueprint-suggestions` **(added, P3, platform admin)**              | paginated (≤ 50) list + `GET …/:provisioningId/bundle`                                                                                                                                                                                                     | default            |

Error contract:

| Situation                                                                                 | Status | Body                                                                                               |
| ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Work is not kind `app`                                                                    | `422`  | `{ code: 'notAppWork' }`                                                                           |
| Readiness flag false (manual or chat start)                                               | `422`  | `{ code: 'provisioningUnavailable', missing: ['isolatedRuntime', …] }`                             |
| Active provisioning, `restart !== true`, manual or chat                                   | `409`  | `{ code: 'provisioningActive', provisioningId, status }`                                           |
| Duplicate start inside `startDedupeMs`                                                    | `202`  | `{ provisioningId, status, deduplicated: true }` — the existing row, nothing cancelled, no new row |
| Suggestion not eligible                                                                   | `422`  | `{ code: 'suggestionNotEligible', reason }`                                                        |
| Suggestion already open for the upstream                                                  | `409`  | `{ code: 'suggestionExists' }`                                                                     |
| Caller lacks edit permission on `provision`, `provision/cancel` or `blueprint-suggestion` | `404`  | same as missing                                                                                    |
| Caller lacks read permission on `GET provisioning`                                        | `404`  | same as missing; a caller who may read but not edit gets `200` with `canEdit: false` (ACC-04-32)   |

### Start semantics

`AppProvisioningService.start({ workId, userId, trigger, restart?, note? })` evaluates exactly this order, once, in one
transaction on the App Work's active row:

1. Not kind `app` → `422 notAppWork`.
2. **Dedupe.** An active row (`queued` / `running` / `needs_input`) created ≤ `startDedupeMs`
   (10 s, §3.2) ago → `202 { provisioningId: <that row>, status, deduplicated: true }`, whatever `restart`, trigger or
   caller said. Nothing is cancelled and no row is written. This is S21 and ACC-04-03: two **Re-provision**
   confirmations inside the window make one provisioning, not two.
3. Active row older than the window and `restart !== true`:
    - `manual` / `chat` → `409 { code: 'provisioningActive', provisioningId, status }`;
    - `auto-create`, `upstream-smoke` and `auto-upstream-smoke` → the active row is returned as a no-op: never 409, never
      cancelled, no second row.
4. **Readiness.** Any false flag in `AppProvisioningReadiness` (§3.2) — `isolatedRuntime`, `agentTemplate`,
   `buildCapability`, `clusterTarget` or `publicRepository`:
    - `manual` / `chat` → `422 provisioningUnavailable { missing }`;
    - automatic triggers → `{ started: false, missing }`, no throw.
      In **both** cases: no row, no Task, no Run, no `app.provision.started`, and nothing is cancelled — not even when
      `restart` is true. The card derives its "No isolated sandbox" / "Private repository" states from `GET …/provisioning`
      readiness. There is **no automatic retry**: once readiness is true the card offers **Provision** (S10).
5. `restart === true` with an active row older than the window: only `manual` / `chat` may pass it. In the same
   transaction the old row is compare-and-set to `cancelled` (its Run, Build and verification target are cancelled by
   the `cancel` event after commit), the new row is inserted, and the caller gets `202 deduplicated: false` (S22).
6. No active row → insert (`queued` with `queuedReason` when the 3-per-user or 10-per-org cap is reached) →
   `202 deduplicated: false`.
7. An insert that loses `uq_work_app_provisionings_active` to a concurrent start → re-read the active row →
   `202 { provisioningId, status, deduplicated: true }`. **Never** 409 and never 500 for that race.

In the web layer the dialog sends `restart: true` only in the running-provisioning variant, and reopens that variant on
a 409 (§5); the chat tool `provisionAppWork` never sends `restart`.

`no-isolated-runtime` (spec §5.3) therefore applies **only** to a provisioning that already exists and then loses its
isolated sandbox before a run is dispatched: the queued-promotion check (§6.3 item 5) and the pre-dispatch check
(§10.2) both fail the row with that reason. A **start** refused for readiness creates no row at all (S10).

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
Builds page of APW-05. Viewers get the card with actions hidden (server returns `canEdit`). The card, the step rows and
both dialogs render **only** from `AppProvisioningResponse` (§3.2) — no extra fetch, no derived field the API does not
send. **View report** links to the Task run record of the last `runIds` entry (FR-34's evidence), or to
`pullRequest.url` when one exists. The **Needs input** headline renders `question.subject.<question.reason>` with
`question.params`; the spending headlines render `reason.tokenCap` / `reason.runnerMinuteCap` (spec §6, S14). The
private-repository state (§2.2, FR-63) renders from `readiness.publicRepository === false` with the headline and reason
copy of spec §6 and no actions.

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
- Before `advance`, the job re-reads the Task's cached `prState`. `closed` or `merged` takes precedence over whatever
  event woke the job, so a `pr-state` notification lost to a held lease (or to a failed port call) is still honoured by
  the next invocation, and a row whose pull request closed during a `build-updated` poll ends `cancelled` rather than
  iterating (ACC-04-29).
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
5. `queued` rows oldest first → promote while user (3) and org (10) caps allow **and readiness is still true**. A
   promotion whose `isolatedRuntime` is now false (or whose `publicRepository` is false, §2.2) fails the row with
   `failed/no-isolated-runtime` and dispatches **no** Run, no Task and no Build — the row exists, so the card shows the
   reason instead of silently waiting.
6. Open `prNumber` rows (`running` / `needs_input` / `succeeded`) whose Task `prState` is `closed`/`merged` (from
   `task-pr-status.service.ts`) → `pr-state` event. This is the **safety net** for a port call that was lost or threw;
   the primary, fast path is the producer hook in §6.5.

### 6.4 Caps and receipts

- **Tokens**: after each run terminal, `tokensUsed += ledger tokens` read through `RunReceiptService.getReceipt(runId)`.
  Before dispatching a run: refuse when `tokensUsed ≥ tokenCap`. The pipeline's per-session USD budget is set to the
  remaining token allowance priced at the resolved model (backstop inside a run).
- **Runner minutes**: when a verification Build reaches a terminal state — **once per Build**; runner boot, its jobs and
  smoke are part of that same Build and are never added again — do `runnerMinutesUsed += WorkBuild.billableMinutes`
  (APW-05 §3.1/§4.8, the Build receipt, rounded up per job). The same number is written into
  `AppProvisioningAttempt.runnerMinutes` and the `app.provision.*` totals, so the card, the Activity row and the receipt
  agree (ACC-04-24). When `billableMinutes` is null (a `lost` Build, for example) fall back to
  `ceil(durationSeconds / 60)`; if that is null too, use the reservation below. Minutes count the same for public and
  private repositories — who pays does not change the count — and a cluster-target boot adds none.
- **Reservation**: before starting a verification Build, refuse with `runner-minute-cap` when
  `runnerMinutesUsed + reservation > runnerMinuteCap`, where
  `reservation = min(headSpec.build.resources.timeoutMinutes, buildMinutesMax) + runnerBootMinutesMax` — 90 at the
  defaults (§3.2), which is exactly the worst case APW-05's verify-mode timeout allows. The reservation is a real upper
  bound: if the Build is still running at `startedAt + reservation`, the step runner calls `IBuildPlugin.cancelBuild`
  and marks the attempt red with reason timeout.
- A refused dispatch asks with reason `token-cap` / `runner-minute-cap`; option "Raise the cap by 1,000,000 tokens" /
  "by 60 runner minutes" creates an approval proposal of action type `budget_override` (guardrails always queue it,
  risk flag `budget_override`); approval patches the cap on the row and dispatches `answered`. The raise is
  `tokenCap = min(tokenCapMax, tokenCap + 1_000_000)` and
  `runnerMinuteCap = min(runnerMinuteCapMax, max(runnerMinuteCap + 60, runnerMinutesUsed + reservation))`, so one more
  Build always fits after a raise; when even `runnerMinuteCapMax` cannot fit one reservation the question offers only
  `stop`.
- Organization defaults: `tokenCap`/`runnerMinuteCap` resolved from instance env
  `EVER_WORKS_APP_PROVISION_TOKEN_CAP` / `EVER_WORKS_APP_PROVISION_RUNNER_MINUTE_CAP` (added to CONTRACTS §7), clamped to
  §3.2 bounds; per-Organization override is P3 (organization settings JSON, additive).

### 6.5 Events in and out

Other epics notify through a port, avoiding import cycles:
`packages/agent/src/app-provisioning/app-provision-events.port.ts` **(new)** exports `APP_PROVISION_EVENTS_PORT` with
`forkReady(workId)`, `buildUpdated(buildId)`, `targetUpdated(workId, namespace)`, `smokeFailedAfterUpstreamSync(workId, fromSha, toSha)`
and — added by this audit — `pullRequestStateChanged(taskId, prState: 'closed' | 'merged')`.
`InboxService` reply routing calls `notify({ event: 'answered' })` when the answered item id matches
`openInboxItemId` (one additive call beside the existing resume path — see §7.7 for why that path resumes nothing).

**`pullRequestStateChanged` — the S17 detector (ACC-04-29).** `TaskPrStatusService.refreshTask`
(`packages/agent/src/tasks-domain/task-pr-status.service.ts`) is the only writer of `prState`, and both the two-minute
`task-pr-status-sync` cron and the on-demand pr-status read call it. The producer captures the Task's `prState`
**before** `updatePrStatusCache`; when the new state is `closed` or `merged` and differs from the captured one, it calls
the port fire-and-forget — catch, warn, and never fail the refresh (the service's own rule 4; `offerRedGateToFixLoop`
at `:319-358` is the pattern to sit beside). The port is injected `@Optional() @Inject(APP_PROVISION_EVENTS_PORT)`,
appended **last** in the constructor, like `PROMOTION_LANE_WATCHER`; the port file has no imports, so there is no cycle.
APW-08 T22 appends `TaskDeliveryService` to the same constructor — whichever lands second appends after the other.
`AppProvisioningService` implements the method: `findByTaskId(taskId)`; when the row is `running`, `needs_input` or
`succeeded` and has a `prNumber`, `notify({ event: 'pr-state', refId: prState })`; otherwise do nothing, which keeps it
idempotent. The bound this buys: detection within about **4 minutes** under normal load (2-minute cron, 120 s stale
floor, 25 per batch) followed by an immediate dispatch — inside S17's 5 minutes — with §6.3 item 6 and the §6.2
`prState` re-read as the fallback, so S17 and ACC-04-29 keep their wording.

Activity (CONTRACTS §6, `app.provision.*`) via `ActivityLogService.log` with `action` = the dotted name and
`actionType` = `ActivityActionType.APP_PROVISION` (`'app_provision'`, appended to
`packages/agent/src/entities/activity-log.types.ts`, R-2), names and counts only:
`started {trigger}`, `proposed {prNumber}`, `attempted {n, verdict, failedStep, targetKind}` **(added)**,
`needs_input {reason}`, `succeeded {attempts, tokens, runnerMinutes, detectionSource}`,
`failed {reason, attempts, tokens, runnerMinutes}`, `blueprint_suggested {upstream}` **(added)**.

**Activity status and feed kind (this audit).** `app.provision.failed` is logged with `ActivityStatus.FAILED`; every
other `app.provision.*` row uses `ActivityStatus.COMPLETED`. `resolveFeedKind` checks status first
(`FEED_PROBLEM_STATUSES` already contains `failed` and `cancelled`, `feed-kind.ts:35-38`), so the failure surfaces as a
`problem` in the Live Feed. `FEED_KIND_RULES` gains `[ActivityActionType.APP_PROVISION]: 'work'` in a commented
"App Works (APW-04)" block, matching the `AGENT_RUN_*` / `GOAL_LOOP_*` / `MISSION_*` entries — **not**
`deliveryWhenCompleted`, because every `app.provision.*` event is its own row and completed `started` / `attempted` /
`needs_input` rows must not read as deliveries. No change is needed in
`packages/agent/src/shared-views/publishable-activity.ts`: `NEVER_PUBLISH_ACTIVITY_ACTIONS` is derived from
`PUBLISHABLE_ACTIVITY_ACTIONS` (`:28-32`), so `app_provision` is unpublished by construction. The pinned count in
`packages/agent/src/entities/__tests__/activity-log.types.spec.ts:410` is recounted to the merged enum (200 on
`develop` @ `873274c9f`, plus every member APW-01/03/05/07 add before this lands), and the `['APP_PROVISION',
'app_provision']` pair joins its `cases` array (T19).

---

## 7. Agent, Skill, sandbox and defences

### 7.1 The Agent

- Template `ever-works/agents/templates/app-provisioner/` (draft in [`agent-template-draft/`](./agent-template-draft/)).
- `AppProvisionerAgentResolver` **(new, `packages/agent/src/app-provisioning/`)** reuses the `agentId` of the caller's
  (or Organization's) most recent `work_app_provisionings` row when that Agent still exists and is not archived, else
  creates one. `agent.entity.ts` has no template-slug column, and this epic does not add one — the provisioning rows
  are the memory. Resolver entry: `resolve({ userId, scope: ownershipScopeOf(work) })`.
- **Ownership rule (this audit — FR-7, FR-8, ACC-04-39).** Agent owner = Task owner = the provisioning row's `userId`
  (the person who started it; the App Work's owner for automatic starts), and both are stamped with the App Work's
  scope, `ownershipScopeOf(work)` = `{ tenantId, organizationId }`. `AgentRunService.execute` refuses any run whose
  `agent.userId !== context.userId` (`agent-run.service.ts:329-334`) and the worker looks the Agent up with
  `findByIdAndUser(payload.agentId, payload.userId)` (`agent-task-execute.task.ts:337`), so an Agent created by one
  Organization member is **never** reused for another member's provisioning: each member who provisions gets their own,
  created on first use in that scope. `findRecentAgentId(userId, scope)` matches on `userId` **and** the exact
  tenant/organization ids (the `organizationId` argument is used, never ignored), and the same person provisioning in
  their personal space and in an Organization gets two Agents with no name conflict.
- Creation path: `AgentTemplatesService.createFromRepoTemplate(userId, slug, input, scope)` **(new, additive)** — reads
  `templates/<slug>/.works/agent.yml`, `SOUL.md`, `skills.yml` through the same pinned-ref reader as
  `AgentTemplateCatalogService` (tokenless raw read, App-installation fallback), validates the manifest against the
  catalog schema's required keys, strips HTML, caps lengths, writes `SOUL.md` through `AgentFileService.write`, applies
  permissions (all false) and guardrails `require_approval`. Only slugs in an allow-list constant
  `REPO_TEMPLATE_INSTANTIABLE_SLUGS = ['app-provisioner']` may be instantiated in P1 (widening is a separate decision).
- Scope: tenant-scoped Agent; one per user per scope, or per Organization when the App Work has an `organizationId`.
- **Required `agent.yml` keys (this audit).** T2 validates this exact list, so its test can be written offline.
  Schema `ever-works/agents/schema/agent-manifest.schema.json`, `schemaVersion: 1` (the schema version the draft
  declares; the companion files it requires are drafted under [`agent-template-draft/`](./agent-template-draft/)):
  `schemaVersion` (integer, `1`), `slug` (lower-case kebab), `name`, `title`, `scope` (`PERSONAL` | `TENANT` |
  `PLATFORM`), `summary`, `capabilities` (non-empty string), `avatarMode` (`ICON` | `IMAGE`), `avatarIcon`,
  `permissions` (object with **every** flag present and boolean — this epic sends all `false`), `heartbeatCadence`
  (integer or `null`), `idleBehavior` (enum, `NOOP` included), `suggestedSkills` (array of catalog slugs),
  `kb.seedPaths` (array of repo-relative directories), `kb.citationPolicy`, `prompts.system` (path),
  `prompts.tasks[]` (`{ id, title, path }`), `soul` (path), `tags` (array). Every path must resolve inside the template
  directory; an unknown or missing key refuses the instantiation rather than guessing (T2's "missing required key →
  refused" case).

### 7.2 The Skill

- `ever-works/skills/skills/provision-app/SKILL.md` (draft in [`skill-draft/SKILL.md`](./skill-draft/SKILL.md)) plus a
  `manifest.json` row (`slug`, `path`, `name`, `summary`, `skillPath`, `tags`, `version`, `license`).
- Installed with `SkillsService.installFromCatalog` on Agent creation, bound `injectIntoAgent: true`, priority 10.
- Frontmatter carries `allowed-tools` (agentskills string) **and** `allowedTools` (array the platform reads).
- Drift guard: `AppProvisionerAgentResolver` refuses to dispatch when the Skill is missing, unbound or disabled and
  re-installs it once; still missing → readiness `agentTemplate: false`.

### 7.3 The sandbox

- Pipeline selection goes through the facade by capability flag, never a plugin id: `IPipelinePlugin` gains
  `readonly enforcesRuntimeNetworking?: boolean` **(additive, `pipeline-plugin.interface.ts`)** and
  `runSandboxSession?` (§2.6), both set only in `packages/plugins/claude-managed-agent/`. Readiness `isolatedRuntime` =
  an enabled pipeline has the flag **and** implements `runSandboxSession` **and** has resolvable settings for this user
  and Work; otherwise the resolver pins the first enabled pipeline that has all three; none → 422
  `provisioningUnavailable` with `missing: ['isolatedRuntime']` (S10). A pipeline with the flag but no runner is not a
  provisioning runtime — the flag without the method would put the run back in the in-process loop (§1.2 blocker 9).
- `publicRepository` is part of readiness too (§2.2): APW-02's `getRepository` must report visibility `public` for the
  data repository, whether it is a Link or a copy. False → `missing: ['publicRepository']`, no row, no token (FR-63).
- The run receives a **pre-resolved** `runtimeEnvironment` (never a stored Environment the user could edit):
  `networkingMode: 'limited'`, `allowPackageManagers: true`, no packages, `allowedHosts`:
  `github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`,
  `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`,
  `sum.golang.org`, `index.crates.io`, `static.crates.io`, `rubygems.org`, `repo.maven.apache.org`,
  `repo.packagist.org`, `api.nuget.org`, `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`, `quay.io`.
  Nothing else; the host validator in `environments.service.ts` already rejects IP literals, `localhost`, `.local`,
  `.internal`.
- `attachedRepos`: exactly one entry (the Work Repository at the Task branch once pushed, else the base ref), `mountDir`
  `repo`. No env files.
- Wall clock via pipeline `timeout`: 45 min (analysis) / 30 min (iterate).

### 7.4 Tool grants

Written on Agent creation and re-asserted before every dispatch (a user edit that widens them blocks dispatch with
readiness `agentTemplate: false` and a card note):

- **Deny** (the proposal's push and pull request are the platform's, through Task finalize — §7.6, R-17):
  `commitToRepo`, `openPullRequest`, `searchWeb`, `extractContent`, `sendEmail`, `messageAgent`,
  `notifyChannel`, `delegateToAgent`, `createSubAgent`, `editAgentFile`, `screenshot`, and all MCP tools
  (`canCallExternalTools: false`). This audit adds `transitionTask`, `createTask`, `commentOnTask` and
  `resolve_escalation`, so the deny list matches FR-10's "every other tool is refused" literally as well as by
  construction.
- **Allow (Agent scope, exact names, no wildcards — FR-10, this audit).** Write
  `allow: ['ask_human', 'appProvisionReport', 'appSpecValidateDraft']` to the provisioner Agent's **own** `tool_grants`
  row through `ToolGrantService.upsert`. `PLATFORM_DEFAULT_TOOL_GRANT` is `allow: ['*']`
  (`packages/contracts/src/policy/tool-grant.types.ts:64-67`), and an Agent-scope `allow` is intersected with the
  inherited set (`:38-49`) — so this narrows the Agent and nothing else. The Agent is dedicated to provisioning (§7.1),
  so no other caller is affected.
    - The grant matrix governs **platform tool descriptors** only. Sandbox file read/search/write is bounded by §7.3 and
      the output guard in §7.6, so it is not named here; if sandbox file access is ever exposed as platform tool
      descriptors, their exact names join this list.
    - `getSkillBody`, `getSkillFile` and `getKbDocument` are deliberately excluded: the Skill body is injected by
      `AppProvisionPromptBuilder` (§7.5) and FR-10 permits no other reads.
- **Virtual `transitionTask`.** `AgentRunService`'s tool loop appends that descriptor **after** the grant filter
  (`agent-run.service.ts:852-870`, the descriptor at `:1365`), so grants alone do not hide it. The provisioning branch
  (§2.3 / T3) dispatches with a new **additive optional** `AgentRunContext.withholdVirtualTransition: true`, and the loop
  skips the descriptor when that is set. Every other run is unchanged (the field defaults to absent).
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

The job composes the question (not the model), so the subject, options and copy are deterministic. Every string comes
from `packages/contracts/src/apps/app-provisioning-copy.ts` (§3.2, T49) — pure English templates whose values equal
§9's `en.json` leaves:

```ts
InboxService.askHuman(
	userId,
	{
		question: appProvisionCopy.questionSubject(reason, params),
		options: appProvisionCopy.questionOptions(reason, params), // ids + labels from §2.5's table
		context
	},
	{ agentId } // deliberately NO agentRunId — see below
);
```

`context` is the Agent's last `question.context` or failing-step summary, redacted, ≤ 2,000 chars, labelled
"written by the agent". Option ids are stable (`retry`, `optional`, `verify-on-cluster`, `accept-build-only`,
`raise-cap`, `choose:<n>`, `stop`); the reason→options and option→patch tables are §2.5's, and the answer is mapped to a
row patch before `answered` resumes the run.

**Stored text is English; web surfaces are keyed (this audit — G09).** Inbox items, reminder notices, chat milestone
messages and pull-request evidence comments are stored as **English** text, exactly as Tasks (APW-02 §8) and the
existing Inbox producers write theirs: there is no translator in `packages/agent`, `apps/api` or `packages/tasks`, and
no user locale column to drive one. The provisioning row keeps **structure** only — `questionReason`, `questionParams`,
option ids, `failureReason`, `queuedReason`, `parkedReason` — and the Work Overview card renders every headline,
including `Needs your input: {questionSubject}`, from keys in the **viewer's** locale (§9), never from the stored Inbox
text. Translating stored Inbox and conversation text is out of scope for this epic: it needs a key+params pair on the
Inbox item and on conversation messages, which is platform-wide follow-up work.

**Filing the question must not resume the run (this audit — G02).** `InboxService.routeQuestionReply` steers or resumes
the run whenever the item carries an `agentRunId` and the run is resumable with a `taskId`
(`packages/agent/src/inbox/inbox.service.ts:762-799`). A provisioning question therefore files with **no**
`agentRunId` (the `{ agentId }` option above): picking "Stop provisioning" or "Raise the cap" must not resume the Agent,
because the **step runner** owns what happens next and the caps must not be bypassed. T20's test asserts zero `steer`
and zero `resume` calls for a matching reply, and that items without a provisioning row behave exactly as before.
Because the question is always the job's, the three-question and four-option ceilings hold too: the sandbox session
(§2.6) reaches no `ask_human` tool, and a model-authored question arrives only as the `question` outcome of §3.3, which
the job composes and files under the same ceilings.

### 7.8 Chat

`AppProvisionChatNotifier` **(new)** posts milestone messages as the Agent via
`ConversationMessageService.appendAgentMessage` into the owner's most recent conversation with
`contextType: 'work', contextId: workId`, creating one titled with the Work name when none exists; ≤ 12 per
provisioning (`chatMessagesPosted`); message bodies from `appProvisionCopy.chat.*` (§3.2, T49) — stored English, per
§7.7's rule — while the card renders its own copy from the viewer's locale.

---

## 8. Cross-epic contracts consumed

| From   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Used for                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| APW-01 | `Work.kind = 'app'`, `sourceRepository.type` / `upstream`; creation hook calls `AppProvisioningService.start({ trigger: 'auto-create' })` when no Blueprint, no valid spec and `sourceRepository.autoProvision !== false` — APW-01 owns that optional field (default `true`, kind `app` only) on `POST /api/works` and on `sourceRepository`, and APW-04 reads it (FR-1, FR-63)                                                                                                                                                                                                                                                                                                                                                                                                                         | FR-1                        |
| APW-02 | `app.fork.ready` / `app.fork.timeout`; `app.upstream.synced` with the synced range                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | repository step; FR-51      |
| APW-03 | App spec schema + `validateAppSpecDocument(yaml, { mode })` (pure) and `AppSpecService.validateDraft(workId, text)`; `POST /api/works/:id/app-spec/validate`; Blueprint resolution result; license class on `WorkAppSpecState`; `scanLicenseHeaders` + `AppLicenseService.recordEvidence`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | guard, validate step, FR-53 |
| APW-05 | `IBuildPlugin.startBuild({ ref, sha, mode: 'verify', verification })`, `getBuild` → status, `logsUrl`, `imageDigest`, **`billableMinutes`** (the runner-minute unit §6.4 adds up; `durationSeconds` is the fallback), `verification` result (runner boot + smoke); `supportedStrategies` (for `auto`) — **accepted, R-10; implemented by APW-05's tasks**                                                                                                                                                                                                                                                                                                                                                                                                                                               | build + runner boot; brief  |
| APW-06 | `AppRenderInput.purpose: 'verification'` + `ttlMinutes` for `IDeploymentPlugin.deployApp`, `getAppStatus`, `destroyApp`, `checkAppCluster`; the `app-cluster-op` job on the isolated worker (production refuses cluster jobs until `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED` is set); `WorkAppRuntimeState` target `your-cluster`; smoke runner (no redirects followed) — **accepted, R-10; implemented by APW-06's tasks**; APW-06 T60's `AppVerificationTargetService` (`packages/agent/src/app-runtime/app-verification-target.service.ts`, namespace `<ns>-v<attempt>`) owns the namespace lifecycle, and APW-04's own `app-verification-target.service.ts` is only the **selector and TTL bookkeeper** that calls it — one verification-target implementation and one namespace scheme (§2.4, T34) | cluster boot + smoke        |
| APW-07 | `AppRuntimeEnvSource` ephemeral mode (generated + derived values in memory, no `WorkAppEnvValue` write) — **accepted, R-10; implemented by APW-07's tasks**; in-namespace and runner dependency containers without persistent volumes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | FR-33, ACC-04-23            |
| APW-13 | Fixture repositories (incl. the prompt-injection fixture in the e2e upstream organization), `EVER_WORKS_E2E_FAKES` fake GitHub, the golden-path acceptance run; the nightly lane step that runs §11.3's live isolation spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | ACC-04-05, 06, 10…15, 34    |

**CONTRACTS.md edits in this PR** (additive): §1 `spec.provisioning.autoReprovision`; §2 `WorkAppProvisioning` (incl.
`questionReason`, `questionParams`, `lastRunOutput`), the view interfaces of §3.2 and the `*_I18N_KEY` maps; §3
`IPipelinePlugin.enforcesRuntimeNetworking` **and `runSandboxSession?`** (§2.6), build `verification` option and deploy
`purpose: 'verification'`, `APP_PROVISION_EVENTS_PORT.pullRequestStateChanged`; §4 three routes plus the
`AppProvisioningResponse` shape of `GET /api/works/:id/provisioning`; §5 `app-provision-sweep`; §6
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
headline.mergedUnverified · headline.failed · headline.cancelled · headline.noIsolatedRuntime · headline.upstreamBroke
headline.privateRepository   (copy: spec §6)
reason.noIsolatedRuntime … reason.verificationInfrastructure · reason.privateRepository   (11 keys, copy: spec §6)
queuedReason.userLimit "you already have 3 provisionings running" · queuedReason.orgLimit "this workspace already has 10 provisionings running"   (spec §6's Queued row)
reasonText.noAnswer {attempts} · reasonText.couldNotVerify {attempts}   (the two reason templates that take a param)
actions.provision "Provision" · actions.reprovision "Re-provision" · actions.cancel "Cancel" · actions.answer "Answer in My Decisions"
actions.openPullRequest "Open pull request" · actions.viewReport "View report" · actions.suggest "Suggest as App Blueprint" · actions.setUp "Set one up"
reprovisionDialog.title · .body · .caps · .activeWarning · .noteLabel · .confirm   (copy: spec §6)
suggestDialog.title · .body · .consent · .submit · suggested "Suggested — thank you. Maintainers review suggestions by hand."
targetCluster "On your cluster" · targetRunner "In the build runner"
stepNote.waitPlatform · stepNote.waitAgent · stepNote.waitWorkspace · stepNote.waitScope   (R-17 waits; copy: spec §6)
stepNote.noteNoChange "Nothing needed changing — the App spec already builds and runs." · stepNote.noteNotRunnable · stepNote.noteQuestion · stepNote.noteMissingValue · stepNote.noteBuildOnly   (§2.5's outcome table)
question.subject.<reason> (9 keys, one per `APP_PROVISIONING_QUESTION_REASON_I18N_KEY` leaf, incl. safetyRail)
question.option.<id> (8 keys — one per `APP_PROVISIONING_OPTION_I18N_KEY` leaf: retry, optional, verifyOnCluster, acceptBuildOnly, raiseCap, choose, stop, retryAfterSetting)
question.reminder.title · question.reminder.body "Still waiting on your answer about {repo}."
chat.started · chat.proposed · chat.attemptRed · chat.succeeded · chat.needsInput · chat.failed   (copy: spec §6)
evidence.* (comment headings: attempt, step, verdict, duration, buildLog, imageDigest, target, smoke, spend)
```

Copy rules (this audit — G09). Every `<reason>`, `<id>` and `queuedReason` leaf above is reached through the maps of
§3.2 (`APP_PROVISIONING_QUESTION_REASON_I18N_KEY`, `APP_PROVISIONING_FAILURE_REASON_I18N_KEY`,
`APP_PROVISIONING_QUEUED_REASON_I18N_KEY`, `APP_PROVISIONING_OPTION_I18N_KEY`) — no id is ever spliced into a key, and
`choose:<n>` resolves through its `choose` prefix with `n` as a param. Keys under `question.*`, `chat.*` and `evidence.*`
exist so the card can show the question subject; the **server** writes the English templates of
`app-provisioning-copy.ts` (§3.2, T49), and every one of those template values is character-for-character the
`en.json` leaf here — T27 asserts the equality in both directions, so the two cannot drift. Stored Inbox, chat and
pull-request text is English (GitHub is not localised and the Inbox stores text); every string the **card** and the
**dialogs** draw resolves from the viewer's locale in all 21 locale files (ACC-04-33).

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

| Failure                                                                                                            | Behaviour                                                                                                                                     | Why                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Run ends without a `provision-output` block                                                                        | Red attempt `no-output`; resume once with the contract restated                                                                               | The model forgot the contract; one reminder is cheap.                                               |
| Sandbox session `failed` with `requiresAction` (§2.6)                                                              | Red attempt `no-output`; the brief restates that no custom tool may be requested                                                              | A session never pauses for a tool and `allow_mcp_servers` is `false` (`runtime-environment.ts:51`). |
| Sandbox session `failed` with `noAgentMessage`                                                                     | Red attempt `no-output`, same resume                                                                                                          | Nothing to guard; the contract is restated once.                                                    |
| Sandbox session `timeout`                                                                                          | Red attempt at `analysis` (or `boot` for a verification build), `IBuildPlugin.cancelBuild` on a build still running at the reservation (§6.4) | FR-14 is a hard wall-clock bound.                                                                   |
| Sandbox session `budget-exhausted`                                                                                 | No new attempt; question reason `token-cap` with receipts                                                                                     | The USD session budget is §6.4's in-run backstop.                                                   |
| Sandbox session `failed` with `provider`                                                                           | Infra verdict, retry ≤ 3 in 30 min (FR-40), attempt counter untouched                                                                         | A provider outage is not the Agent's fault.                                                         |
| Isolated runtime lost **after** the row exists (queued promotion §6.3 item 5, or the pre-dispatch readiness check) | `failed/no-isolated-runtime`; no Run, Task or Build dispatched                                                                                | The row exists, so the card must state the reason.                                                  |
| `start` refused for readiness                                                                                      | No row, no Task, no Run (S10, §4 Start semantics step 4)                                                                                      | A refusal is not a failed provisioning.                                                             |
| Guard throws                                                                                                       | Attempt `infra`, retry; never pushes                                                                                                          | A guard that cannot run must not pass anything.                                                     |
| Push rejected (branch protection)                                                                                  | `failed/verification-infrastructure` with the provider message key                                                                            | Nothing to iterate on.                                                                              |
| Build plugin not configured                                                                                        | Readiness `buildCapability: false`; start refused                                                                                             | Fail before spending tokens.                                                                        |
| Cluster namespace create refused (RBAC)                                                                            | Infra verdict; this attempt falls back to runner                                                                                              | User cluster permissions are not a code problem.                                                    |
| Destroy of verification namespace fails                                                                            | Sweeper retries every 15 min; card note after 3 failures                                                                                      | Never leave a silent leak.                                                                          |
| Inbox answer arrives after cancel                                                                                  | Ignored (row not `needs_input`); answer recorded on the item                                                                                  | Cancel is final.                                                                                    |
| Two workers advance the same row                                                                                   | Lease CAS; loser exits                                                                                                                        | One effect set per event.                                                                           |
| Effect replay after crash                                                                                          | Idempotency key `(provisioningId, attempt, effect)` in `stepStates`                                                                           | Re-dispatch safe.                                                                                   |
| PR comment fails                                                                                                   | Logged; evidence still on run + card                                                                                                          | Evidence must not fail verification.                                                                |
| Agent widened its grants between runs                                                                              | Dispatch refused; readiness false; card note                                                                                                  | Defences are re-asserted, not assumed.                                                              |

---

## 11. Test plan

### 11.1 Unit (Jest, agent package)

| File **(new)**                                                                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/app-provisioning/__tests__/provision-output.guard.spec.ts`                 | Every violation code: path escape, `.github/**`, lockfile, > 12 files, > 3,000 lines, > 128 KB, literal secret, example-value reuse, preserved-field change, unpinned `FROM`, missing smoke/probes, cron without auth; violations never contain values.                                                                                                                                                                                                                                                          |
| `packages/agent/src/app-provisioning/__tests__/provision-output.schema.spec.ts`                | Last-block selection, size cap, strict unknown keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/agent/src/app-provisioning/__tests__/app-provision-session.runner.spec.ts` **(new)** | Fake plugin double (§2.6): system and prompt are sent, `budgetUsd` and `timeoutMs` are forwarded, exactly one tokenless `attachedRepos` entry, `requiresAction` → `failed/requiresAction`, `noAgentMessage`, `timeout`, `budget-exhausted`, tokens and cost written to the run row, output persisted and capped at 512 KB, **no** fallback to `AgentRunService.execute`, and no capable plugin → refused with zero run spend (ACC-04-42).                                                                        |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning-step-runner.spec.ts`           | Table test over §2.5 × events; attempt CAS; fingerprint repeat → ask; infra retries do not consume attempts; ceilings (3 questions, 9 attempts); caps refuse dispatch; R-17: parked `kill-switch` / `agent-paused` / `workspace-paused` / `scope-paused` runs are waits (no attempt, no infra retry, `activeMs` frozen) and every other safety `reasonCode` ends in `needs_input` with reason `safety-rail`.                                                                                                     |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.service.spec.ts`               | Start dedupe; restart cancels; per-user 3 / per-org 10 queueing; readiness flags (incl. `publicRepository`); suggestion eligibility and bundle scrubbing; the §4 start-semantics order end to end — a double restart inside `startDedupeMs` yields one id with `deduplicated: true` and cancels nothing, a lost unique-insert race returns the winner, a `422` with `restart: true` cancels nothing, and `pullRequestStateChanged` dispatches `pr-state` once for an open row and is a no-op for a terminal one. |
| `packages/agent/src/app-provisioning/__tests__/app-provision-evidence.renderer.spec.ts`        | Comment shape, truncation at 60,000, redaction, no env values.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/agent/src/app-provisioning/__tests__/app-provision-prompt.builder.spec.ts`           | Fences around instruction files, note and evidence; injection strings stay inside fences.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/agent/src/app-provisioning/__tests__/app-provisioner-agent.resolver.spec.ts`         | Create once, reuse; grants re-asserted; widened grants refuse dispatch; skill re-install once.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/agent/src/agents/__tests__/agent-templates.repo-template.spec.ts`                    | `createFromRepoTemplate` allow-list, schema-required keys, HTML strip, SOUL write.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/task-workspace.provisioning.spec.ts`                | Push-only and PR-without-review variants; existing `finalizeRun` golden behaviour unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/tasks/src/__tests__/agent-task-execute.provisioning-branch.spec.ts`                  | Provisioning Tasks skip workspace/gate and the default post-run finalize and notify; other Tasks unchanged.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.auto-start.spec.ts`            | APW-01 creation-service double: no Blueprint + no valid spec starts within 60 s of readiness (Task, row, `app.provision.started`); a matched Blueprint, a valid spec, a declined creator (`sourceRepository.autoProvision === false`) or a false readiness flag starts nothing and writes no row (ACC-04-01, ACC-04-02, ACC-04-41).                                                                                                                                                                              |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.verification-env.spec.ts`      | Runner and cluster attempts request APW-07's ephemeral mode; a `WorkAppEnvValue` repository spy records zero writes across red → green (ACC-04-23).                                                                                                                                                                                                                                                                                                                                                              |
| `packages/agent/src/app-provisioning/__tests__/app-provision-chat.notifier.spec.ts`            | Milestones posted in the Work thread (created when absent), never more than 12 per provisioning (ACC-04-28).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/agent/src/app-provisioning/__tests__/app-provisioning.finalize-path.spec.ts`         | With a `publish` rung of `ask`, push + PR go through `TaskWorkspaceService` finalize with no held action; `commitToRepo` / `openPullRequest` refused for the run (ACC-04-37).                                                                                                                                                                                                                                                                                                                                    |

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
  Vitest, inside the plugin's `src/**/\*.spec.ts` include)**:`describe.runIf(process.env.APW_E2E_LIVE === '1')`, so the
PR lane skips it. It opens a real managed session through **§2.6's `runSandboxSession`** with the §7.3 environment, so
the spec exercises the production path rather than a private one. The probe is a **single fixed model turn** with a
deterministic tool-use instruction (`managed-agents-client.ts`offers only`sendUserMessage`and`waitForSessionIdle`— both model turns — and no command-execution API), whose transcript is asserted: the platform API origin from`APW_E2E_ALLOWED_BASE_URLS`, an RFC1918 address, `169.254.169.254`and an unlisted public host must fail;`github.com`and`registry.npmjs.org`must succeed;`env`names and`git config --list`pass through`scanForSecrets`with zero
matches (ACC-04-05/06). A second case with`networkingMode: 'unrestricted'`must see the unlisted host succeed — the
known-bad control that proves the probe can fail. **Credential plumbing** (this audit): the spec resolves its settings
through the same`resolveManagedAgentSettings`seam the plugin uses, seeded from the plugin config every other
managed-agent spec uses, falling back to`APW_E2E_MANAGED_AGENT_API_KEY`(the variable ACCEPTANCE.md:120 already
names) only when no plugin setting is present; with neither, the spec reports **skipped**, never failed, exactly as it
does without`APW_E2E_LIVE`. Run by the nightly lane as
`APW_E2E_LIVE=1 pnpm --filter @ever-works/claude-managed-agent-plugin test -- provision-sandbox-isolation.live`(lane step requested from APW-13, whose job list is`interlocks → fixture → umami → safety → cleanup → evidence`;
  the isolation step is added there, and until it lands ACC-04-05/06's live half is recorded as **not yet observed** —
  T33's and T4's "Done when" are stated as the lane step plus a recorded green run, never assumed).

### 11.4 Skill evals

`ever-works/agents/eval/app-provisioner.yml` (catalog repo, schema `eval.schema.json`) with 8 fixture repositories
maintained under APW-13: app-spec present, compose, Dockerfile, Helm, descriptor-hint, zero-config `auto` (source code
only — expected `auto` when the brief lists it, an overlay Dockerfile when it does not), bootstrap-risk +
swallowed-migration, cron + fixed-length key. Expected: detection source, dependency set, env classifications, jobs,
cron, probes (ACC-04-10…15).

**This audit (EXT-11).** `eval.schema.json` is a **conversation** format (turns plus free-text expectations) and the
catalog repository's only CI is a schema validator — there is no eval runner and no field for a fixture repository or a
structured expectation. So the fixtures and their expectations are drafted **here**, in this epic's folder, and the
catalog file only references them:

- Drafted under [`eval-draft/`](./eval-draft/): `app-provisioner.yml` (the catalog file, schema-shaped),
  `fixtures/<case>/tree.md` + `fixtures/<case>/.works/…` for each of the eight cases, and `expectations.json` — the
  structured expectation per case (detection source, dependencies with the citing file, env classifications, jobs,
  cron, probes, overlay Dockerfile yes/no, `auto` yes/no) that ACC-04-10…15 assert.
- Run by the **monorepo** nightly lane, not by the catalog: a spec in `packages/agent/src/app-provisioning/__tests__/`
  reads `expectations.json` against the fixture trees with the Skill's playbook as a table test, so an eval regression
  is a red test in this repository (T32's Test line names it). The catalog file stays the human-readable catalogue
  entry and is validated by that repository's schema CI.
- **APW-13 ownership** is unchanged and additive: APW-13 creates the eight fixture repositories (and their
  `variant/<name>` branches per R-23) in the e2e organization; until it does, the drafted trees are the source of truth
  and the nightly spec runs from them. The APW-13 task text is reported to this PR's author (see the epic's report) —
  it adds a row, it removes none.

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

`enforcesRuntimeNetworking` flag **and `runSandboxSession` (§2.6) on the pipeline contract, implemented by the
managed-agent plugin**; `createFromRepoTemplate` (allow-list of one); worker provisioning branch behind a row lookup
(no rows exist yet, so inert); sandbox isolation live spec in the plugin package (§11.3). The **session runner itself**
(`AppProvisionSessionRunner`) is T48 in P1 and lands before T19.

### P1 — Provision, verify in the runner, ask (Wave 1)

Entity + migration; contracts; service; dispatcher + job + sweeper (items 2–6); Agent/Skill/grants/Environment; guard;
writer + PR variants; validate + build + **runner** boot + smoke; evidence; iterate; questions; caps; card, dialogs,
chat, Activity, telemetry, i18n; catalog PRs for the template and the Skill. **The provisioning session runner (T48)
lands first in P1, before the service (T19)** — without it the analysis run has no sandbox to run in (§2.6).
**Depends on** APW-01 P1, APW-03 P1, APW-05 P1 (with `verification`), APW-07 P1 (`AppRuntimeEnvSource` ephemeral mode).

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
- [x] **III — Source of truth in repos.** The App spec lands by PR in the Work Repository; the table is derived state;
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

- **Single isolated runtime.** Until a second pipeline enforces Environment networking **and** implements
  `runSandboxSession` (§2.6), provisioning is only available where the managed-agent pipeline is configured. Fleet nodes
  are excluded in P1 (open question in spec §9).
- **Private data repositories** (a private copy, or a Link whose visibility is `private` or `internal`) are **refused in
  Wave 1 P1** with readiness `publicRepository: false` (§2.2, FR-63, ACC-04-40): no row, no mount, no token minted. The
  lift path is additive and named: a narrowed mint (repository ids + `contents: read`) plus a token-carrying mount field
  proven absent from the sandbox shell by a live probe.
- **Draft pull requests** are not used: the provider contract has no ready-for-review operation. The Task state and the
  card carry "verifying"; merging early is allowed and recorded as unverified.
- **In-run token cap** relies on the pipeline's USD session budget; token-exact enforcement happens between runs.
