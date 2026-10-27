# APW-09 Upstream pull requests — lane log (B3 `aw-upstream-prs`, overnight 2026-10-27)

Spec: [`docs/specs/features/app-works/APW-09-upstream-pull-requests/`](../../../specs/features/app-works/APW-09-upstream-pull-requests/)
(`spec.md`, `plan.md`, `tasks.md`). `CONTRACTS.md` wins over epic text.

## Plan of record

| Phase | Tasks                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status      |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1     | T6, T7, T35 (record half)                                             | Contracts (`packages/contracts/src/apps/upstream-pull-request.types.ts`), Activity family `app_upstream_pr` + feed-kind rule, the three entities + migrations (`1792090100000` / `0200000` / `0300000`), `UpstreamPullRequestRepository`, `UpstreamPullRequestRecordService`, and the direct `POST /api/works/:id/upstream-pr` writing the record (claim before the provider call, `409 activeProposal`, `opening → open` / `failed`). | in progress |
| 2     | T8 (limits half), T9 (DB-level), T10, T11, T19 (no-credential routes) | FR-26 / FR-39 rate limits enforced server-side (direct route included), eligibility, `GET /api/works/:id/upstream-pull-requests`, `…/eligibility`, `…/:prId`, `POST …/:prId/withdraw`, `POST …/:prId/acknowledge-extra-files`, the Task's **Propose upstream** button.                                                                                                                                                                 | next        |
| 3     | T20, Upstream-tab section                                             | Opt-in setting read, Upstream tab PR list.                                                                                                                                                                                                                                                                                                                                                                                             | if time     |

## Decisions

1. **Migration slots (R-39).** APW-09 slot `00` (`1792090000000`) is T43's `AddWorkUpstreamCredentialMember`, so the
   three tables take slots `01` (`CreateUpstreamPullRequests`), `02` (`CreateWorkUpstreamPrSettings`) and `03`
   (`CreateUpstreamPrSuggestions`) in merge order — not the plan's `00`/`01`/`02` authoring order.
2. **Two columns beyond plan §3.1, one relaxation** (additive): `origin` (`proposal` · `direct`) and `draft` on
   `upstream_pull_requests`; `sourceTaskId` is nullable because the direct route may name a fork branch instead of a
   Task. NULLs never collide in the partial unique index on either driver.
3. **One extra index** `idx_upr_upstream_opened (upstreamOwner, upstreamRepo, openedAt)` for FR-39's platform-wide
   ceiling, which counts across every member (the plan's per-member index leads with `userId`).
4. **The direct route claims before it calls the provider.** A row in `opening` holds the source Task's active slot
   (FR-5) and stamps `openedAt` so a concurrent request counts it; success moves it to `open` (number, URL,
   `nextCheckAt = +30 min`), a provider refusal to `failed` (clears `openedAt`, keeps the provider message with the
   token redacted). A direct row stuck in `opening` for 15 minutes is released by the next claim on the same Task.
5. **`GitPullRequestReview` is not redeclared in contracts**: T2 landed it in the plugin SDK. The detail view's `diff`
   is a structural subset (`UpstreamPullRequestDiffView`) because contracts depends on no workspace package.
6. **APW09-G24 defaults** (CL-39, still an owner decision): 1 per upstream per day, 3 overall per day, `maxOpen` from
   the App spec (default 3, ceiling 10), platform ceiling 5 per upstream per day. Built as the defaults.
7. **Fixed on the way (not this epic's, but red on develop):** `app_health` (APW-06 T29) had no `FEED_KIND_RULES` row
   and the Activity literal count was not bumped, so `feed-kind.spec.ts` and `activity-log.types.spec.ts` were red.
   Added `app_health: 'work'` and recounted (222 with `app_upstream_pr`).

## Account transfer (owned tonight by lane B4)

The three new tables hold user data. `account-transfer/backup/collectors/domain-specs.ts` needs, in the `works`
domain, after `members.jsonl`:

- `upstream-pull-requests.jsonl` — entity `UpstreamPullRequest`, scope `{ by: 'parent', column: 'workId', … }` (the
  parent Work ids; plan §3 preamble: nothing redacted);
- `upstream-pr-settings.jsonl` — `WorkUpstreamPrSetting`, same parent scope;
- `upstream-pr-suggestions.jsonl` — `UpstreamPrSuggestion`, same parent scope.

No column matches the redaction guard's secret-shaped families (no `token`/`secret`/`hash`/`credential` name, no
encrypted column), so no `BACKUP_BENIGN_COLUMNS` entry is needed.

## Questions for the owner

- **APW09-G24 / CL-39** (open, recorded default built): confirm 1 pull request per upstream per day and 3 overall per
  day, or set per-plan numbers.
- **Should the direct `POST /api/works/:id/upstream-pr` require the App spec opt-in (`upstreamPullRequests.enabled`)?**
  Built default: it does **not** (it predates the opt-in and is a member's deliberate act on their own fork branch);
  rate limits and the one-active-record rule now apply to it.

## Next step

Phase 2 (see the table). Then: T13–T19 prepare → approve → open → track (needs the T5 spike on a throwaway GitHub
pair), T21–T24 / T41 / T43 / T44 (credential handover route, budget booking), T26–T28 (P3).
