# EW-614 — Wire EverWorksGitProvider into createWork

> **Status**: implemented (2026-05-13). This document is the in-tree
> companion to the Jira ticket [EW-614]. It describes what the wire-up
> changes, where, and how to verify.

EW-608 shipped the choice-driven onboarding wizard plus an env-gated
`EverWorksGitProvider` service. The provider was built and unit-tested but
**never called** — `work.storageProvider = 'ever-works-git'` was persisted
but the runtime repo create still fell through to the user's GitHub OAuth
via the existing git facade. EW-614 closes that gap end-to-end.

After this change, picking **Ever Works Git** in the wizard produces a
real private repository under
[github.com/ever-works-cloud](https://github.com/ever-works-cloud), pushed
to with the platform PAT (see `EVER_WORKS_CUSTOMERS_GITHUB_PAT`), never
the user's personal credentials.

---

## 1. Scope at a glance

| Piece                     | Where                                                                                                                  | What changes                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Pre-create**         | `packages/agent/src/services/work-lifecycle.service.ts::createWork`                                                    | If `storageProvider==='ever-works-git'` AND `everWorksGit.isEnabled()`, pre-generate the Work UUID and call `EverWorksGitProvider.createRepository(...)` BEFORE the DB insert. Override `workData.owner`/`organization`/`sourceRepository.relatedRepositories.work` from the provider response. |
| **B. Token resolver**     | `packages/agent/src/facades/git.facade.ts::resolvePluginAndToken`                                                      | New short-circuit at the top of the resolver: when `options.workId` belongs to an `ever-works-git` Work AND the env flag is on, return the platform PAT before any user-OAuth lookup. Transparently routes ALL git-facade methods (create, push, pull, status, getRepository, ...).             |
| **C. Activity-log actor** | `packages/agent/src/events/work-created.event.ts` + `apps/api/src/activity-log/activity-log.listener.ts`               | `WorkCreatedEvent` gains an optional `platformActor` payload. The activity-log listener forwards it under `metadata.actor` / `metadata.repository` so audit rows distinguish "platform acted on user's behalf" from a regular user-initiated create.                                            |
| **D. Tests**              | `work-lifecycle.create-defaults.spec.ts`, `git.facade.spec.ts`, `activity-log.listener.spec.ts`, `work.module.spec.ts` | 11 new unit tests covering the platform-PAT happy path, flag-off fallback, non-ever-works-git fallback, missing-workId fallback, transient DB blip fallback, direct-token-wins precedence, and provider-error → HTTP-exception mapping.                                                         |
| **E. Update guard**       | `packages/agent/src/dto/update-work.dto.ts` (no change needed)                                                         | `UpdateWorkDto` already omits `storageProvider`, and the global `ValidationPipe` is `whitelist: true`. Clients cannot mutate the field after create.                                                                                                                                            |

> "Piece D — schema-level `actorKind` column on `activity_log`" was
> filed as out-of-scope on the original EW-614 ticket (waiting for ≥2
> non-user actor kinds before paying for the schema migration). The
> metadata-JSONB path is sufficient today.

---

## 2. Why pre-create the repo BEFORE the DB insert

Two reasons:

1. **No orphan DB rows.** If GitHub rejects the create (rate-limit, org PAT
   revoked, network blip), the Work never enters our DB, so a retry by the
   user gets a clean slate.
2. **`relatedRepositories.work` captures the actual repo name.** The
   provider's collision-suffix path (`-{shortId}`) means the resolved repo
   name can differ from the user's `slug`. Pre-creating lets us persist
   the full coordinates in `sourceRepository` on the first DB write,
   without a follow-up UPDATE.

The Work UUID is pre-generated with `node:crypto.randomUUID()` and passed
to the provider so its collision-suffix derivation
(`work.id.replace(/-/g, '').slice(0, 7)`) is deterministic; the same UUID
is then handed to TypeORM as the row's `id`.

### Failure cleanup

The DB insert can still fail AFTER the GitHub repo was created (slug
collision on `(userId, owner, slug)`, transient DB blip). When that
happens today the `ever-works-cloud` repo is left orphaned. We didn't add
a compensating delete because:

- The slug-collision branch in `workRepository.create` was already a
  user-visible error before EW-614; one orphaned repo every few thousand
  creates is acceptable.
- A best-effort `EverWorksGitProvider.deleteRepository` doesn't exist
  yet; adding it just for this rollback widens the surface unnecessarily.
- A cleanup cron over `ever-works-cloud` repos with no matching Work row
  is a better long-term fix.

Tracked as a follow-up cleanup task on the EW-614 close-out comment.

---

## 3. Why the git-facade hook lives in `resolvePluginAndToken`

Every git-facade method (`createRepository`, `push`, `pull`, `status`,
`getRepository`, `hasRepositoryAccess`, ...) funnels through
`resolvePluginAndToken(options)`. Adding the platform-PAT short-circuit at
the top of that one method gives us:

- **Single edit point** — no need to teach each facade method about
  storage-provider semantics.
- **No new API surface** — the existing `GitFacadeOptions.workId` already
  flows through. Callers that don't pass `workId` (one-off lookups against
  arbitrary repos) get unchanged behaviour.
- **Test coverage via existing methods** — we exercise `createRepository`
  in the new tests; the same short-circuit fires for `push`/`pull`/etc.

The resolver returns `null` (falls through to existing OAuth/PAT logic)
when ANY of these is true:

- `options.workId` is unset
- `STORAGE_EVER_WORKS_GIT_ENABLED` is off
- The Work doesn't exist or has a different `storageProvider`
- `EVER_WORKS_CUSTOMERS_GITHUB_PAT` is empty (misconfig safety)
- `workRepository.findById` throws (transient DB blip)

The last point — fall through on DB error — matches "what the user sees
when the feature is off" and avoids crashing every git call when the
Work-table read blips.

---

## 4. Activity-log payload

When the platform creates the repo, the `WorkCreatedEvent` is emitted
with a `platformActor` payload:

```ts
new WorkCreatedEvent(work, {
	actorKind: 'platform',
	actor: 'ever-works-cloud',
	repoFullName: 'ever-works-cloud/evereq-my-work',
	htmlUrl: 'https://github.com/ever-works-cloud/evereq-my-work'
});
```

The listener records it under `metadata`:

```json
{
	"actor": { "kind": "platform", "id": "ever-works-cloud" },
	"repository": {
		"fullName": "ever-works-cloud/evereq-my-work",
		"htmlUrl": "https://github.com/ever-works-cloud/evereq-my-work"
	}
}
```

A regular user-initiated create (any non-Ever-Works-Git storage) still
fires `WorkCreatedEvent` — we now emit it unconditionally, fixing a
gap where the event was wired but never raised — and the activity row's
`metadata` is `undefined`. Down-stream consumers (`activity-log.listener`,
`work-created.listener` for user-research learning) handle both shapes.

---

## 5. Error mapping

`EverWorksGitProvider` throws typed errors. `WorkLifecycleService` maps
them to HTTP-shaped NestJS exceptions so controllers don't have to:

| Provider error                   | HTTP exception                      | When it fires                                                                                                                                 |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `EverWorksGitDisabledError`      | `BadRequestException` (400)         | Feature flag was on at `resolveProviderDefaults` time but off by the time the provider executed — should be impossible, but mapped for safety |
| `EverWorksGitMisconfiguredError` | `ServiceUnavailableException` (503) | PAT empty or org empty mid-flight (env was misconfigured between API startup and now)                                                         |
| `EverWorksGitRequestError`       | `ServiceUnavailableException` (503) | GitHub returned a non-2xx (rate-limit, 5xx, both `{user}-{slug}` AND `{user}-{slug}-{shortId}` already taken in the org)                      |

The Work is NOT persisted in any of these cases (the provider call comes
before `workRepository.create`).

---

## 6. Configuration touchpoints (unchanged from EW-608)

All env values are inherited from the EW-608 wiring (PR #721) — nothing
new in `.env.example`, the k8s manifests, or the deploy workflows.

```env
STORAGE_EVER_WORKS_GIT_ENABLED=true            # gate
EVER_WORKS_CUSTOMERS_GITHUB_ORG=ever-works-cloud
EVER_WORKS_CUSTOMERS_GITHUB_PAT=github_pat_…    # secret (GH Actions)
EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY=private
```

See `docs/specs/features/onboarding-wizard-v2/deployment.md` §1 for the
rotation runbook.

---

## 7. Smoke-test recipe (post-cascade)

On any env (dev/stage/prod) with the flag enabled:

1. Register a fresh user via `POST /api/auth/register`.
2. Drive the wizard with default storage (Ever Works Git) OR call
   `POST /api/works { slug, name, description, storageProvider: 'ever-works-git' }`
   directly.
3. Verify the response: `work.owner === 'ever-works-cloud'`,
   `work.organization === true`, `work.sourceRepository.relatedRepositories.work`
   set.
4. `GET https://github.com/orgs/ever-works-cloud/repositories` →
   the new private repo appears with name `{user-slug}-{work-slug}`.
5. `GET /api/activity-log?workId={id}` → the WORK_CREATED row's
   `metadata` matches §4.
6. Trigger any downstream git op (e.g. generate items, push README) —
   confirm the operation lands in `ever-works-cloud` and NOT the user's
   personal GitHub.
7. Clean up: delete the repo via the API (uses the platform PAT
   transparently) + delete the test user.

---

## 8. Out-of-scope

- Switching `storageProvider` after Work creation. UI doesn't expose it
  and `UpdateWorkDto` doesn't accept it. Future ticket if needed.
- The "Ever Works Deploy" equivalent — blocked on `k8s-works` cluster +
  SSL termination, which is owner-provisioned separately.
- Moving the platform PAT to a GitHub App installation token (cleaner
  long-term, eliminates manual PAT rotation). Separate ticket.
- Schema-level `actor_kind` column on `activity_log`. Metadata-JSONB is
  enough until we have ≥2 non-user actor kinds.
- Orphan-repo cleanup cron (see §2 "Failure cleanup").
