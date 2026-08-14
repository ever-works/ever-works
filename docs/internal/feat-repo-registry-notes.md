# Feature G — Repository registry (multi-repo support)

Branch: `session/feat-repo-registry`. Internal implementation notes for the PR reviewer.

## What shipped

A global, account-level **repository registry** under **Settings → Repositories** (a new
settings tab — not a new sidebar item). Repositories become standalone records independent of
Works: URL, display name, workspace mount directory, description, a credential **pointer**, and
encrypted seed `.env` files. Registry rows can be attached to individual Agents, which is the
edge the future per-agent Capabilities page will read.

Everything is additive. The Work three-repo model (`sourceRepository.relatedRepositories`
`{data|work|website}`) is untouched; Work repos are **surfaced** in the registry listing as
computed, read-only entries rather than copied into the new table.

## Data model

Two new tables, migration `apps/api/src/migrations/1785010000000-CreateRepoConnections.ts`
(portable Table API, idempotent `hasTable` guards, both `up` and `down`).

### `repo_connections` (`packages/agent/src/entities/repo-connection.entity.ts`)

| column                                     | notes                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `id`                                       | uuid PK                                                                                             |
| `userId`                                   | owner; FK → `users` CASCADE                                                                         |
| `tenantId`, `organizationId`               | Tier-C scope denorm, nullable, no `@ManyToOne` (EW-654 no-cycle rule)                               |
| `name` varchar(120)                        | display name **and** the default mount dir; unique per user                                         |
| `url` varchar(512)                         | https or ssh clone URL, validated at the API boundary                                               |
| `provider` varchar(16)                     | `github` \| `git`                                                                                   |
| `defaultBranch` varchar(120)?              |                                                                                                     |
| `mountPath` varchar(200)?                  | single traversal-free segment; NULL → falls back to `name`                                          |
| `description` text?                        |                                                                                                     |
| `credentialMode` varchar(24)               | `inherit` \| `github-app` \| `secret-ref` (default `inherit`)                                       |
| `credentialRef` varchar(200)?              | **pointer only** — `env:NAME`, `plugin:github`, or a `GitHubAppInstallation` id. Never a raw token. |
| `envFiles`                                 | `EncryptedJsonColumn` holding `{ [path]: content }`. ≤ 8 files, each ≤ 32 KB                        |
| `availableInAllProjects` boolean           | default true                                                                                        |
| `sourceType` varchar(16)                   | `manual` \| `work` \| `github-app` (default `manual`)                                               |
| `sourceWorkId`, `sourceInstallationRepoId` | uuid?, provenance back-pointers                                                                     |
| `enabled` boolean                          | default true                                                                                        |
| timestamps                                 |                                                                                                     |

Indexes: `uq_repo_connection_user_name` (unique `userId,name`), `idx_repo_connection_user`.

`sourceType: 'work'` is **reserved**: Work-derived entries are computed on read and never
persisted, so no row carries that value yet. The discriminator exists so a future
"pin this Work repo" flow needs no schema change.

### `agent_repo_attachments` (`packages/agent/src/entities/agent-repo-attachment.entity.ts`)

`id, userId, agentId, repoConnectionId, enabled, tenantId?, organizationId?, timestamps`.
Unique `(agentId, repoConnectionId)`; CASCADE FKs to `agents`, `repo_connections`, `users`.
`enabled` lets an attachment stay configured but temporarily off.

**No scope XOR CHECK** on either table — deliberate; `ScopeStampingSubscriber` populates
`tenantId` and `organizationId` together on ordinary inserts, so an XOR constraint would abort
on real data (the `work_knowledge_uploads` lesson).

Registrations (the missing-registration 500 bug class): both entities are exported from
`entities/index.ts`, listed in `database/_entities-inventory.ts` **and**
`database/_entity-names.ts`; both repositories are in `database/_repository-inventory.ts` and
re-exported from `database/index.ts`.

## Endpoints

Module `apps/api/src/repo-connections/`, registered in `apps/api/src/api.module.ts`.
Default JWT guard, `@CurrentUser()`, cross-user rows read as **404** (never 403).

```
GET    /api/repo-connections                                   list (?includeDerived=true)
POST   /api/repo-connections                                   create
GET    /api/repo-connections/:id                               one (env files masked)
PATCH  /api/repo-connections/:id                               partial update
DELETE /api/repo-connections/:id                               delete
GET    /api/repo-connections/:id/env-files                     FULL contents (owner-gated reveal)
PUT    /api/repo-connections/:id/env-files                     replace the set ("Save All")
POST   /api/repo-connections/import/github-app/:installationRepoId   one-click import

GET    /api/agents/:agentId/repos                              registry + attachment state
PUT    /api/agents/:agentId/repos/:repoConnectionId            attach / set enabled
DELETE /api/agents/:agentId/repos/:repoConnectionId            detach
```

**Env-file masking is the load-bearing security property**: every list/get response carries
paths + byte sizes only (`RepoConnectionEnvFileMeta`); contents leave the API exclusively
through `GET :id/env-files`. Nothing logs env content, and activity rows carry only the repo
name + row id.

**Import conflicts are loud 409s, never silent suffixing** — both "already imported"
(`sourceInstallationRepoId` hit) and "a repo with that name exists". The user renames and
retries. Importing sets `credentialMode: 'github-app'` with `credentialRef` = the installation
entity id, so token minting resolves through the App at use time.

Validation lives in both layers: DTOs (`dto/repo-connection.dto.ts`) pin shape/length and the
`mountPath` regex; `RepoRegistryService` re-validates URL scheme, mount path, and the env-file
caps so non-HTTP callers cannot bypass them.

## Domain service

`packages/agent/src/services/repo-registry.service.ts` owns the whole surface: CRUD with
masking, the derived-row union, GitHub-App import, and the agent-attachment edge. Activity rows
(`REPO_CONNECTION_CREATED/_UPDATED/_DELETED/_IMPORTED`, `REPO_ATTACHED_TO_AGENT`,
`REPO_DETACHED_FROM_AGENT`) are emitted best-effort through an `@Optional()` `ActivityLogService`
appended **last** in the constructor, so every existing positional construction keeps working.

Module-level helpers (not methods — they have consumers outside the Nest graph):

- `mapAttachmentEdgesToRepos(edges)` — pure edge → `ResolvedAgentRepo` mapping. Both the
  attachment flag and the repo row's own `enabled` must be on.
- `resolveAttachedReposForAgent(attachments, agentId, userId)` — the provisioning read,
  **with** full env-file contents. Server-side only; never serialize it to a response.
- `toAdvisoryRepoSpecs(repos)` — strips env files (and the row id) for anything crossing the
  plugin boundary.

Derived Work entries get synthetic ids (`work:<workId>:<role>`) that cannot collide with row
uuids, `readonly: true`, and no edit/delete affordance in the UI.

## Provisioning wiring (v1, additive)

- `WorkspaceProvisionSpec.attachedRepos` (`packages/plugin/.../workspace.interface.ts`) — an
  **advisory**, token-free, env-file-free list. v1 sandbox/local providers ignore it;
  it rides the spec now so future multi-mount executors need no contract churn.
- `TaskWorkspaceService.provisionForRun` accepts an optional `agentId` (passed by
  `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts`) and resolves the agent's
  enabled attachments through the shared resolver. Best-effort **by contract**: no agent, no
  attachment repository bound, or a failed read all degrade to "no extra repos" — an advisory
  field must never fail a provision. The key is omitted entirely when the list is empty, so
  existing provision specs stay byte-identical.
- `PipelineExecutionOptions.attachedRepos` (`AttachedRepoResource[]`, **with** env files) is
  the pipeline-side carrier, same posture as `memorySessionId`.
- `claude-managed-agent` consumes it: `buildSessionResources()` in
  `packages/plugins/claude-managed-agent/src/utils/session-resources.ts` emits the seed-manifest
  file resource first (unchanged), then one `github_repository` resource per attached repo at
  `/workspace/<mountDir>`, then each uploaded env file at `/workspace/<mountDir>/<path>`.
  Uploaded env-file ids are tracked on `ManagedAgentRunResources.uploadedEnvFileIds` and cleaned
  up with the rest of the run. **With no attachments the resource array is byte-identical to
  what the plugin has always sent** — pinned by a unit test.

## Web UI

- Route `apps/web/src/app/[locale]/(dashboard)/settings/repositories/page.tsx` (server
  component; lists with `includeDerived=true` and tolerates a flaky GitHub-App API).
- Tab registered in `settings-layout-client.tsx`; `ROUTES.DASHBOARD_SETTINGS_REPOSITORIES`
  in `lib/constants.ts`.
- `components/settings/RepositoriesSettings.tsx` — table (Name, URL, Credential, Source badge
  Manual/Work/GitHub App, Updated) + a two-tab Add/Edit form: **General** (URL, Name, Mount Path
  with the `/workspace/<mount>` hint, Default Branch, Credential Key picker offering GitHub-App
  installations or an `env:` pointer, Description, Available-in-all-projects) and
  **Environment** (`.env` file list, Add .env file, Save All, masked on reload behind a Reveal
  action). Import-from-GitHub-App block lists installation repos not yet imported.
- `components/agents/AgentReposCard.tsx` — the minimal "Repositories" section on the agent
  settings page (additive and movable; the Capabilities page absorbs it later).
- Server actions in `app/actions/repo-connections.ts` return a discriminated result union
  (never branch on `err.message` — the Server-Action prod-redaction bug class).
- i18n keys added to **all 21** locale files under `dashboard.settings.repositories.*` plus
  `dashboard.settings.tabs.repositories` (English copy in every locale, per house rule).

## Tests

```bash
# agent (Jest) — registry service + provisioning + the activity-enum pin
cd packages/agent && npx jest src/services/__tests__/repo-registry.service.spec.ts \
  src/tasks-domain/__tests__/task-workspace.service.spec.ts \
  src/entities/__tests__/activity-log.types.spec.ts

# claude-managed-agent (Vitest) — session-resource assembly
cd packages/plugins/claude-managed-agent && npx vitest run

# type-check / build
npx turbo type-check --filter=@ever-works/agent --filter=ever-works-api \
  --filter=ever-works-web --filter=@ever-works/plugin --filter=claude-managed-agent-plugin
```

Covered: URL / mount-path / env-file cap validation; masking (create, get, setEnvFiles) and the
owner-gated reveal; 409 duplicate name; 404 cross-user read/update/delete; derived-row union
(with and without `includeDerived`); import idempotency + name clash + foreign/suspended
installation; the attachment authz matrix; the provisioning resolver and the advisory-spec
env-file strip; CMA payload assembly including the byte-stable no-attachment case.

`activity-log.types.spec.ts` pins the total `ActivityActionType` literal count — bumped 123 → 129
for the six additive entries.

## Known follow-ups

1. **No producer for `PipelineExecutionOptions.attachedRepos` yet.** Pipeline plugins are today
   dispatched only from the Work-generation path (`DataGeneratorService.executePipeline` →
   `PipelineOrchestratorService`), which has no Agent in scope; agent runs go through
   `AgentAiDispatchFacade`, not a pipeline plugin. The carrier + the CMA consumer ship now (same
   posture as `memorySessionId`, which is also read-only today); wiring the producer belongs to
   whichever change introduces an agent-scoped pipeline dispatch, and should call
   `resolveAttachedReposForAgent`.
2. **Local/sandbox workspace multi-mount is out of scope** (explicitly, per the brief). The
   advisory `attachedRepos` field is carried on `WorkspaceProvisionSpec` but no provider mounts
   it yet.
3. **Credential resolution does not yet consume `credentialMode` / `credentialRef`.** The
   registry records where a credential lives; `GitFacadeService.resolvePluginAndToken`'s 5-step
   chain is unchanged. Teaching the facade to prefer a registry row's pointer is a separate,
   security-sensitive change.
4. **No API-level e2e specs.** Coverage is service-level; a `repo-connections` validation/authz
   matrix spec under `apps/web/e2e` would be cheap to add later.
5. **`availableInAllProjects` is stored and surfaced but not yet enforced** anywhere — the
   attachment edge is the only thing provisioning reads today.
