# APW-09 Upstream pull requests — lane log (B3 `aw-upstream-prs`, overnight 2026-10-27)

Spec: [`docs/specs/features/app-works/APW-09-upstream-pull-requests/`](../../../specs/features/app-works/APW-09-upstream-pull-requests/)
(`spec.md`, `plan.md`, `tasks.md`). `CONTRACTS.md` wins over epic text.

## Plan of record

| Phase | Tasks                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                       |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | T6, T7, T35 (record half)                                             | Contracts (`packages/contracts/src/apps/upstream-pull-request.types.ts`), Activity family `app_upstream_pr` + feed-kind rule, the three entities + migrations (`1792090100000` / `0200000` / `0300000`), `UpstreamPullRequestRepository`, `UpstreamPullRequestRecordService`, and the direct `POST /api/works/:id/upstream-pr` writing the record (claim before the provider call, `409 activeProposal`, `opening → open` / `failed`). | merged (#2963)               |
| 2     | T8 (limits half), T9 (DB-level), T10, T11, T19 (no-credential routes) | FR-26 / FR-39 rate limits enforced server-side (direct route included), eligibility, `GET /api/works/:id/upstream-pull-requests`, `…/eligibility`, `…/:prId`, `POST …/:prId/withdraw`, `POST …/:prId/acknowledge-extra-files`, the Task's **Propose upstream** button.                                                                                                                                                                 | merged (#2966)               |
| 3     | T20, Upstream-tab section                                             | Opt-in setting read, Upstream tab PR list.                                                                                                                                                                                                                                                                                                                                                                                             | section: PR; T20 not started |

MERGED: #2963 → `develop` at `d3ea42ec1` (phase 1).
MERGED: #2966 → `develop` at `df6307e52` (phase 2; CodeRabbit's four findings fixed in `43084bc7f` and answered on the threads).
Phase 3 (part): the Upstream-tab **Upstream pull requests** section — read-only list in the APW-02 slot.

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
6. **APW09-G24 defaults** (CL-39, still an owner decision): 1 per upstream per day, 3 overall per day (operator
   override `EVER_WORKS_APP_UPSTREAM_PR_MAX_PER_DAY`, 1–20, R-31), `maxOpen` from the App spec (default 3, ceiling 10),
   platform ceiling 5 per upstream per day. Built as the defaults. The organization-level cap (20) of R-31 is not built.
7. **Fixed on the way (not this epic's, but red on develop):** `app_health` (APW-06 T29) had no `FEED_KIND_RULES` row
   and the Activity literal count was not bumped, so `feed-kind.spec.ts` and `activity-log.types.spec.ts` were red.
   Added `app_health: 'work'` and recounted (222 with `app_upstream_pr`).
8. **Limits on the direct route run twice**: before the claim (cheap refusal, no credential touched) and after it
   with the claim counted (`includesSelf`), so two concurrent requests cannot both pass a pre-check. A request refused
   on the second look moves its own claim to `refused` and clears `openedAt`.
9. **Eligibility needs edit access** (FR-35: proposing needs edit). A viewer's eligibility read is the one `404`, so the
   Task page renders no button for them. The list and one-record reads need view access.
10. **Withdraw: the author or the App Work owner** (spec silent on who; the owner controls the Work, any other editor
    is `403 authorRequired`). The fork branch is left for the status job (`forkBranchDeletedAt` NULL), because deleting
    it needs the member's token and no credential is used by the route.
11. **Acknowledge extra files: the author only, a human session only** (FR-49's acknowledgement is the review of the
    person whose name goes on the pull request; an API key or automation is refused by `requireHumanSession`).
12. **Propose upstream stays disabled even when eligible** until the preparation step ships
    (`preparationAvailable: false`); the reason line says so. It never calls the direct route: a Task branch carries the
    fork's own commits, which FR-8/FR-9 require the preparation step to strip.
13. **Locales:** the new keys were appended to the 20 sibling locales with English placeholders by a targeted script.
    `scripts/sync-locale-parity.mjs` was NOT run: it would also have added 4,641 keys other lanes left out, per locale.
14. **Backup (R-25):** after B4's #2964 merged, the three tables were appended to `domain-specs.ts` (`works` domain,
    parent Work ids, nothing redacted). No column matches the redaction guard's families.

## Questions for the owner

- **APW09-G24 / CL-39** (open, recorded default built): confirm 1 pull request per upstream per day and 3 overall per
  day, or set per-plan numbers.
- **Should the direct `POST /api/works/:id/upstream-pr` require the App spec opt-in (`upstreamPullRequests.enabled`)?**
  Built default: it does **not** (it predates the opt-in and is a member's deliberate act on their own fork branch);
  rate limits and the one-active-record rule now apply to it.
- **Who may withdraw a proposal?** Built: the author or the App Work owner.

## Next step

1. T20 (not started): `UpstreamSettingService` — the toggle writes the App spec change through `commitFiles` (a
   setup pull request where R-4 needs one), pending state in `work_upstream_pr_settings` (the table exists), the
   toggle in the Upstream-tab section. The section itself is read-only today; a **Withdraw** button over
   `POST …/:prId/withdraw` (a server action + client button) is the next small step once proposals exist.
2. T8 rest: `summarize-upstream-checks.ts`, `upstream-fingerprint.ts`. T9 rest: the provider reads (archived,
   network root, pull requests disabled, interaction limit, push permission, maintainer opt-out) with the member token.
3. T13–T19 prepare → approve → open → track (needs the T5 spike on a throwaway GitHub pair), then mount
   `POST …/upstream-pull-requests`, `…/signed`, `…/check`, `…/address-review`, `…/suggestions/:taskId/dismiss`.
4. T21–T24 / T41 / T43 / T44 (credential handover route, budget booking), T26–T28 (P3), the MCP whitelist entries for
   the three reads (plan §5 parity table).
