# Fleet multi-repo Task workspaces — implementation notes (self-build slice C, EW-765)

Branch `feat/fleet-multi-repo-workspaces`, stacked on slice B (`feat/fleet-node-run-reconciliation`,
#2298), which is stacked on slice A (#2297). Design:
`Workspace/knowledge/notes/2026-09-03-fleet-multi-repo-workspaces-design.md`.

## What shipped (PR C1)

A Task keeps ONE primary Work and branch. When its run agent has enabled **repository attachments**
(the repository registry), a fleet run now checks those repositories out next to the primary
worktree, lets the model edit them, pushes each changed one on the same Task branch name, opens one
pull request per repository and links them all on the Task.

### Contracts (`@ever-works/contracts`)

- `FleetTaskWorkspaceSpec.mounts?: FleetTaskWorkspaceMountSpec[]` — `{ repositoryId, repoUrl, baseRef,
branch, mountDir, writable, depth? }`; `FleetTaskWorkspaceDescriptor.mounts?` with `path`, `linkPath`,
  `mountDir`, `writable` per mount.
- `FleetAgentTaskGitResult.repositoryId? / mountDir?` and `FleetAgentTaskResult.mountGit?` — one git
  verdict per writable mount.
- `normalizeFleetTaskWorkspaceMounts(raw, primaryRepositoryId)` — refuse-never-coerce: at most
  `FLEET_TASK_WORKSPACE_MAX_MOUNTS` (8), `mountDir` a single safe name (no leading or trailing dot — Windows
  strips trailing dots, so `api.` and `api` would be one directory — never `.git`, `.mounts`,
  `node_modules` or a Windows device name such as `NUL` / `COM1`, ≤ 64 chars), unique case-insensitively,
  never the primary repository, remote token-free URLs only. `isReservedMountDir(name)` is the ONE
  reserved-name rule, shared with the API DTO and the Task extra-repositories validation.

### Node (`apps/node`)

- `FleetTaskWorkspaceProvisioner.provision` provisions each mount as its OWN binding under the fleet
  root (same pool / reuse / ownership proof as the primary), then links it into the primary worktree
  at `.mounts/<mountDir>` — a directory **junction** on Windows (no privilege needed), a directory
  symlink elsewhere — and writes `/.mounts/` to the repository's shared `info/exclude` (temporary file +
  rename, then verified with `git check-ignore`, because another worktree's finalize may be reading the
  file), so the primary's `git status`, `git add -A` and diffs never see the mounts. An existing link to
  the same target is kept; a real directory at the link path is a `path-collision` naming the path.
- `.mounts` is untrusted between runs (the model runs in the reused primary as the node's account):
  before anything is written through it the provisioner proves it is a plain directory directly under
  the primary — a link, junction or file there is a `path-collision` — and on EVERY provision (a run
  without mounts included) drops the links of mounts the current spec no longer names, so a repository
  the operator removed does not stay reachable. Real directories under `.mounts/` are never removed.
- A reused READ-ONLY mount is reset to its base commit (`git reset --hard` + `git clean -fd`) on
  provision, so what a model left in it never leaks into the next run or into the first push after
  `writable` flips.
- `finalizeMounts` commits and pushes every WRITABLE mount (`git add -A` / commit / push through the
  local-workspace plugin, exactly like the primary) and returns one verdict per mount; a failure is
  recorded on its entry and never stops the others. Cancellation propagates, unprefixed.
- The `agent-task` executor finalizes mounts FIRST, the primary LAST (so the primary PR can link the
  others), and carries `mountGit` in the result. A failed mount fails the run naming the mount.

### Agent (`@ever-works/agent`)

- `TaskWorkspaceService.describeFleetWorkspace({ task, userId, agentId })` derives mounts from the
  agent's enabled attachments: `repositoryId` from the clone URL (`repositoryIdFromCloneUrl`), `baseRef`
  from the connection's default branch or the provider, `branch` = the Task branch, `mountDir` = the
  connection's mount path or name. Refuses an attachment it cannot describe; skips the primary itself.
- `TaskWorkspaceService.finalizeMountPush(...)` opens the pull request for a pushed mount (title
  suffixed with the repository, body cross-linked to the primary PR and carrying the run summary) and
  upserts `Task.linkedPullRequests` by repository. Idempotent like the primary path: a re-run whose push
  updated the branch behind an already-open pull request re-records that pull request instead of asking
  the provider for another (which would fail and replace the link with a `failed` entry). Provider
  failures are recorded (`state: 'failed'`), never thrown. Agents without `canOpenPullRequests`, and
  generic `git` connections, record `pushed`.
- Plan-time refusals never echo a registry URL verbatim (`credentialFreeUrlForMessages`): a connection
  URL is only shape-checked at the registry, so it may carry userinfo, and the refusal lands on the
  AgentRun, the Task page and the API log.
- `Task.linkedPullRequests` (simple-json, nullable) + migration `1787800000000-AddTaskLinkedPullRequests`.
- `ResolvedAgentRepo.provider` (from the connection) so the fleet path knows which provider to use.

### API (`apps/api`)

- Planner passes the run agent to `describeFleetWorkspace` and describes the mounts in the
  `# WORKSPACE (fleet node)` section (`describeWorkspaceSection`): where each repository is, that
  every changed repository gets its own branch and pull request, which mounts are read-only.
- Reconciler: after the primary, one `finalizeMountPush` per pushed mount; the task-chat message lists
  every repository's outcome; ONE Inbox notice lists every pull request to review. A failed run's
  pushed mount branches are recorded on the Task (no PR) so they are not orphaned.
- The node's `mountGit` is untrusted: the reconciler acts only on verdicts whose repository is a
  WRITABLE mount of the job's planned `workspace.mounts` (same normalizer as the node), on the planned
  Task branch, with a well-formed head; repository, branch and base come from the plan, never from the
  report. Anything else is logged, mentioned as ignored in the chat note, and never becomes a pull
  request or a `linkedPullRequests` entry. A throw while recording a mount pull request is caught like
  the primary's, so the run always reaches `markCompleted`.

### Web

- `Task.linkedPullRequests` on the web type; the Task branch section lists the linked repositories with
  their PR link (or "pushed" / "failed" state). Keys `dashboard.tasksPage.branch.linkedPullRequests`,
  `linkedPrPushed`, `linkedPrFailed` in all locales.
- The agent settings Repositories card says what attaching a repository now means for fleet runs
  (`dashboard.settings.repositories.agentCard.fleetHint`, all locales).

## PR C2 — Task-level extra repositories

- `Task.extraRepos: TaskExtraRepo[] | null` (`{ repoConnectionId, mountDir?, writable? }`, contracts
  `packages/contracts/src/tasks/task-extra-repos.types.ts`, `TASK_MAX_EXTRA_REPOS = 8`) + migration
  `1787900000000-AddTaskExtraRepos`. `TasksService.normalizeExtraRepos` validates on create and update:
  every connection must belong to the Task OWNER (the identity the plan resolves connections under; an
  org member editing another member's Task is refused at edit time with a message saying so) and be
  enabled and describe an `owner/repository` URL; the EFFECTIVE mount directory (explicit `mountDir`,
  else the connection's mount path or name) must pass the fleet gate (`isReservedMountDir` included)
  and be unique case-insensitively; two connections may not point at the same repository; at most 8.
  The API DTOs carry `TaskExtraRepoDto` (`@ever-works/agent/dto`), which applies the mount-directory
  pattern AND `isReservedMountDir` itself, so a Windows device name or `node_modules` is a 400 naming
  `mountDir` at the request boundary rather than one layer later; the field is exposed to the web chat
  tools `create_task` / `update_task` (body hint) and in the Swagger document — the MCP server whitelist
  (`apps/mcp/src/openapi-tools/whitelist.ts`) does not include `/api/tasks`, so no MCP tool carries it.
- `describeFleetWorkspace` merges the Task's extras AFTER the agent's attachments; a Task entry wins over
  an AGENT ATTACHMENT on the same repository or mount directory, while two Task extras that collide fail
  the plan naming both. Missing, disabled or unparseable connections fail the plan naming them (URL
  credential-free). `finalizeMountPush` resolves the provider of an extra from its own connection
  (attachment → Task extra → Work provider), so a generic `git` extra records `pushed` instead of a
  failed pull request.
- Web: `TaskExtraReposPicker` ("Also work in": a checkbox per enabled registry connection with the
  `.mounts/<dir>` it will get) on the new-task form and the task page (saved through `updateTaskAction`).
  `listRepoConnections` server action. Keys under `dashboard.tasksPage.extraRepos`, `newDialog.extraRepos*`,
  `detail.extraRepos*` in all locales.

## Deliberate limits

- Extra repositories are registry CONNECTIONS. Pointing a Task at another Work's repository directly
  (a `repo` Work from slice D) is a follow-up once D merges.
- Read-only mounts: the API creates one via `extraRepos[].writable = false` (PR C2); the "Also work in"
  picker does not expose `writable` or a custom `mountDir` yet — agent attachments are always writable.
- Acceptance checks still run in the primary worktree only.
- The primary PR body is not edited after the mount PRs exist; the cross-link is on each mount PR
  ("Part of <primary PR>") and in the task chat / Inbox.
- `recordLinkedPullRequest` is a plain read-modify-write of `Task.linkedPullRequests` (`simple-json`;
  sqlite and postgres share no portable JSON merge). Two completions of ONE Task reconciled at the same
  moment (two runs, or a failure path racing a success path) read the same base and the later write
  drops the other's entry — the pull request stays open on the remote but leaves the Task and the Inbox
  count. Serializing the upsert per Task (an optimistic `updatedAt` guard with one retry, or
  `SELECT … FOR UPDATE` on postgres) is a follow-up.

## Verification

| Check                                                                                                                                                                                                                  | Result                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `cd packages/contracts && npx vitest run src/fleet`                                                                                                                                                                    | 8 files, 557 tests                                   |
| `cd packages/contracts && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                           | clean                                                |
| `cd apps/node && npx vitest run src/core/executors/agent-task-mounts.spec.ts src/core/executors/agent-task-model-cli.spec.ts src/core/executors/agent-task.spec.ts src/core/workspaces` (real Git for the mount suite) | 5 files, 89 tests                                    |
| `cd apps/node && npx tsc --noEmit`                                                                                                                                                                                     | clean                                                |
| `cd packages/agent && npx jest --testPathPattern='task-workspace-mounts\|task-workspace-fleet\|task-workspace-remote-push\|repo-registry'`                                                                             | 4 suites, 76 tests                                   |
| `cd packages/agent && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                               | clean                                                |
| `cd apps/api && npx jest --testPathPattern='fleet-agent-task-planner\|fleet-agent-task-reconciler\|AddTaskLinkedPullRequests'`                                                                                         | planner (13) + reconciler (29) + migration (3) green |
| `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`                                                                                                                                                               | clean                                                |
| `cd apps/web && npx tsc --noEmit`                                                                                                                                                                                      | clean                                                |
| `cd apps/web && npx vitest run src/components/agents/AgentReposCard.unit.spec.tsx src/components/tasks/TaskBranchSection.unit.spec.tsx`                                                                                | 2 files, 4 tests                                     |
| Prettier on every changed file                                                                                                                                                                                         | clean                                                |

PR C2 (`feat/fleet-task-extra-repos`), on top of the table above:

| Check                                                                                                                                      | Result                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/agent && npx jest --testPathPattern='dto.spec\|tasks.service.extra-repos\|task-workspace-extra-repos\|task-workspace-mounts'` | 5 suites, 260 tests (`src/dto` 109 incl. `TaskExtraRepoDto`, items-generator dto 85, extra-repos service 18, extra-repos workspace 16, mounts 32) |
| `cd packages/agent && npx tsc --noEmit -p tsconfig.json`                                                                                   | clean                                                                                                                                             |
| `cd apps/api && npx jest --testPathPattern='AddTaskExtraRepos'`                                                                            | 1 suite, 2 tests                                                                                                                                  |
| `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`                                                                                   | clean                                                                                                                                             |
| `cd apps/web && npx vitest run src/components/tasks/TaskExtraReposPicker.unit.spec.tsx src/lib/ai/tools`                                   | 10 files, 102 tests                                                                                                                               |
| `cd apps/web && npx tsc --noEmit`                                                                                                          | clean                                                                                                                                             |

Not run: the end-to-end scenario on a real node (needs A+B on prod); documented in the Workspace
runbook `EVER_WORKS_FLEET_NODES.md` §6.
