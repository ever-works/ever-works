# Fleet — agent execution v2 (model CLIs on the node)

Branch `feat/fleet-node-agent-execution`, based on `origin/develop`. Slice **A** of the
self-build program (Workspace `knowledge/notes/2026-09-02-self-build-fleet-program.md`, gaps
G1 + G5).

Before this, an enrolled machine could be handed an `agent-task` and the only thing it could do
with it was run an **instance-global shell template** (`FLEET_NODE_AGENT_TASK_COMMAND`). The
node's model-CLI executor library (`apps/node/src/core/model-execution/`, #2168) existed but was
wired to nothing — `grep createModelProcessExecutor apps/node/src` hit only its own tests. So
"run the agent on my PC" meant "run whatever command the platform operator typed", for every
tenant alike.

## What shipped

**One new execution mode, chosen per tenant, additive to the legacy one.**

| Layer                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ever-works/contracts`          | `FleetAgentTaskPayload` gains `execution` (`FleetAgentModelExecution`: provider, instructions, model, effort, permissionMode, skipPermissions, timeoutSec, maxBudgetUsd, envPassthrough), `acceptanceChecks`, `git`. New shared result contract `FleetAgentTaskResult` (+ `…ModelResult`, `…GitResult`). `normalizeFleetAgentModelExecution` refuses rather than coerces. Vocabularies + defaults pinned in tests.                                                                                                                                                                                                   |
| `job-runtime-node` plugin        | `settingsSchema` gains `agentExecutionMode` (`command` default / `model-cli`), `agentExecutionProvider`, `…Model`, `…Effort`, `…PermissionMode`, `…TimeoutSeconds`, `…MaxBudgetUsd`, `…SkipPermissions` (each with an `x-envVar`). The Job Runtime settings page renders them from the schema — no web change needed for the tenant to switch modes.                                                                                                                                                                                                                                                                 |
| `@ever-works/agent` config       | `config.fleetNode.getAgentExecution*()` — the instance floor, same shape as the existing `FLEET_NODE_*` getters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@ever-works/agent` tasks-domain | `TaskWorkspaceService.describeFleetWorkspace(task, userId)` → token-free `FleetTaskWorkspaceSpec` (same owner/repo/baseRef/branch resolution as `provisionForRun`, branch persisted on the Task). `tokenFreeCloneUrl` refuses — never strips — a credentialed URL.                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api` fleet                 | `FleetAgentTaskPlannerService` (provided by the api `TasksModule`, like the scope resolver): resolves settings (env ← tenant plugin settings, non-default sources only, validated), loads Task/Agent/Work, describes the workspace, assembles instructions through `PromptAssemblerService` (identity, role, skills) + the Task brief in the cloud executor's shape + fleet sections, freezes the acceptance checks, derives the git policy from `agent.permissions.canCommitToRepo`.                                                                                                                                |
| `apps/api` dispatcher + router   | `createFleetAwareAgentTaskExecuteDispatcher` takes `planner`; after a fleet routing decision it plans and hands the plan to `FleetRunRouterService.enqueueAgentTask(payload, queuedReason, plan)`. A plan REPLACES the legacy steps (never both) and adds the provider tag to `requiredCapabilities`. A planner failure propagates → the run row records why.                                                                                                                                                                                                                                                        |
| `apps/node`                      | `agent-task` executor: `execution` → provision worktree → **model step through `runNodeCommandStep`** (instructions from a scratch file on stdin, JSON/JSONL output to a scratch file; `claude -p --output-format json --permission-mode …` / `codex exec --json --sandbox … -`) → acceptance checks → `FleetTaskWorkspaceProvisioner.finalize` (plugin `finalize`: add/commit/push) → `FleetAgentTaskResult`. `model-cli.ts` builds/validates the command and parses the output; `model-cli-probe.ts` resolves the CLIs once at startup; `claude-code` / `codex` capability tags; `--claude-path` / `--codex-path`. |

## Where the brief and the code disagreed

1. **The hardened `model-execution/` executor is not used.** It fails closed unless a signed
   Windows Job-Object helper (Authenticode subject + cert SHA + artifact SHA) is configured, and
   refuses provider credentials outright pending a task-scoped broker. Neither exists yet. A fleet
   PC is its owner's own machine, so the model step goes through the runner the node already
   trusts for every check (env scrub, timeout, cancellation, whole-tree termination). The
   executor seam is `AgentTaskIo.modelCli` + the command builder; routing through the hardened
   executor once a signed helper ships is a one-file change in the composition root.
2. **Instructions travel in the job payload**, not by reference. The payload cap is 256 KB, so
   instructions are capped at 160 KB and the planner trims the SYSTEM prompt tail-first to fit —
   never the Task brief or the workspace facts. A reference-by-id design would need a node-
   authenticated read endpoint; deferred to the reconciliation slice (B), which adds node-side
   platform calls anyway.
3. **No platform tools inside the CLI session.** The instructions say so explicitly and ask the
   model to leave the tree untouched and explain when the Task cannot be completed. `ask_human`
   / task chat from a node run is slice **G** (MCP tools for Tasks/Inbox).

## Verification

```
cd packages/contracts && npx vitest run src/fleet/__tests__      # incl. fleet-agent-execution.spec (vocab, normalizer)
cd packages/plugins/job-runtime-node && npx vitest run            # schema still valid
cd packages/agent && npx jest src/config/config.spec.ts           # new getters
cd packages/agent && npx jest src/tasks-domain/__tests__/task-workspace   # describeFleetWorkspace + tokenFreeCloneUrl
cd apps/api && npx jest src/fleet                                 # planner + model-cli dispatch wiring + existing suites
cd apps/node && npx vitest run                                    # model-cli builder/parser, probe, executor (model path), existing suites
```

Type-checks: `@ever-works/contracts`, `@ever-works/agent`, `ever-works-api`, `ever-works-node`.

Known pre-existing: `apps/node/src/core/windows-job-launcher/windows-job-helper-trust.windows.spec.ts`
needs the Rust helper built (`cargo build` under `apps/node/native/windows-job-launcher`); it is
exercised by the dedicated `windows-job-launcher.yml` workflow, not by a plain `vitest run`.

## Follow-ups (tracked in the program note)

- **B — reconciliation + cancellation**: `fleet.job.leased/completed` → AgentRun + Task + PR
  open from the pushed branch; `FleetJobService.cancel` + store `cancel`; composite run canceller.
- **C — multi-repo mounts** on the workspace spec.
- **G — MCP tools** so a node-run CLI can `ask_human` / post task chat.
- Codex output parsing is best-effort (last `agent_message`); Claude's JSON envelope is the
  primary path.
