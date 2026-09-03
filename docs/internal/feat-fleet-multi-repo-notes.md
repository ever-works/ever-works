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
  `FLEET_TASK_WORKSPACE_MAX_MOUNTS` (8), `mountDir` a single safe name (no leading dot, never `.git`,
  `.mounts`, `node_modules`, ≤ 64 chars), unique case-insensitively, never the primary repository, remote
  token-free URLs only.

### Node (`apps/node`)

- `FleetTaskWorkspaceProvisioner.provision` provisions each mount as its OWN binding under the fleet
  root (same pool / reuse / ownership proof as the primary), then links it into the primary worktree
  at `.mounts/<mountDir>` — a directory **junction** on Windows (no privilege needed), a directory
  symlink elsewhere — and appends `/.mounts/` to the repository's shared `info/exclude`, so the
  primary's `git status`, `git add -A` and diffs never see the mounts. An existing link to the same
  target is kept; a real directory at the link path is a `path-collision`.
- `finalizeMounts` commits and pushes every WRITABLE mount (`git add -A` / commit / push through the
  local-workspace plugin, exactly like the primary) and returns one verdict per mount; a failure is
  recorded on its entry and never stops the others. Cancellation propagates.
- The `agent-task` executor finalizes mounts FIRST, the primary LAST (so the primary PR can link the
  others), and carries `mountGit` in the result. A failed mount fails the run naming the mount.

### Agent (`@ever-works/agent`)

- `TaskWorkspaceService.describeFleetWorkspace({ task, userId, agentId })` derives mounts from the
  agent's enabled attachments: `repositoryId` from the clone URL (`repositoryIdFromCloneUrl`), `baseRef`
  from the connection's default branch or the provider, `branch` = the Task branch, `mountDir` = the
  connection's mount path or name. Refuses an attachment it cannot describe; skips the primary itself.
- `TaskWorkspaceService.finalizeMountPush(...)` opens the pull request for a pushed mount (title
  suffixed with the repository, body cross-linked to the primary PR and carrying the run summary) and
  upserts `Task.linkedPullRequests` by repository. Provider failures are recorded (`state: 'failed'`),
  never thrown. Agents without `canOpenPullRequests`, and generic `git` connections, record `pushed`.
- `Task.linkedPullRequests` (simple-json, nullable) + migration `1787800000000-AddTaskLinkedPullRequests`.
- `ResolvedAgentRepo.provider` (from the connection) so the fleet path knows which provider to use.

### API (`apps/api`)

- Planner passes the run agent to `describeFleetWorkspace` and describes the mounts in the
  `# WORKSPACE (fleet node)` section (`describeWorkspaceSection`): where each repository is, that
  every changed repository gets its own branch and pull request, which mounts are read-only.
- Reconciler: after the primary, one `finalizeMountPush` per pushed mount; the task-chat message lists
  every repository's outcome; ONE Inbox notice lists every pull request to review. A failed run's
  pushed mount branches are recorded on the Task (no PR) so they are not orphaned.

### Web

- `Task.linkedPullRequests` on the web type; the Task branch section lists the linked repositories with
  their PR link (or "pushed" / "failed" state). Keys `dashboard.tasksPage.branch.linkedPullRequests`,
  `linkedPrPushed`, `linkedPrFailed` in all locales.

## Deliberate limits

- Mounts come from AGENT attachments only. Task-level extra repositories (`extraRepos`) and the form
  picker are PR C2.
- Read-only mounts are supported end to end in the contract and the node (never committed), but nothing
  creates one yet (attachments are always writable).
- Acceptance checks still run in the primary worktree only.
- The primary PR body is not edited after the mount PRs exist; the cross-link is on each mount PR
  ("Part of <primary PR>") and in the task chat / Inbox.

## Verification

| Check                                                                                                                                                                                                                  | Result                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `cd packages/contracts && npx vitest run src/fleet`                                                                                                                                                                    | 8 files, 548 tests                              |
| `cd packages/contracts && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                           | clean                                           |
| `cd apps/node && npx vitest run src/core/executors/agent-task-mounts.spec.ts src/core/executors/agent-task-model-cli.spec.ts src/core/executors/agent-task.spec.ts src/core/workspaces` (real Git for the mount suite) | 5 files, 83 tests                               |
| `cd apps/node && npx tsc --noEmit`                                                                                                                                                                                     | clean                                           |
| `cd packages/agent && npx jest --testPathPattern='task-workspace-mounts\|task-workspace-fleet\|task-workspace-remote-push\|repo-registry'`                                                                             | 4 suites, 65 tests                              |
| `cd packages/agent && npx tsc --noEmit -p tsconfig.json`                                                                                                                                                               | clean                                           |
| `cd apps/api && npx jest --testPathPattern='fleet-agent-task-planner\|fleet-agent-task-reconciler\|AddTaskLinkedPullRequests'`                                                                                         | planner + reconciler (17) + migration (3) green |
| `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`                                                                                                                                                               | clean                                           |
| `cd apps/web && npx tsc --noEmit`                                                                                                                                                                                      | see PR body                                     |
| Prettier on every changed file                                                                                                                                                                                         | clean                                           |

Not run: the end-to-end scenario on a real node (needs A+B on prod); documented in the Workspace
runbook `EVER_WORKS_FLEET_NODES.md` §6.
