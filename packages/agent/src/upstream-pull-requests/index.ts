/**
 * Public API of the upstream pull-request epic (APW-09) — imported as
 * `@ever-works/agent/upstream-pull-requests`.
 *
 * Same convention as `app-works/index.ts`: the barrel starts with the one thing
 * this epic exports today and grows additively as its services land, so an
 * importer never has to reach into a deep path
 * (`@ever-works/agent/upstream-pull-requests/upstream-credential.service`).
 * Nothing is re-exported speculatively — a name that does not exist yet must not
 * appear here, or `apps/api` and `packages/tasks` would compile against a module
 * that does not resolve.
 *
 * - `./upstream-credential.service` — `UpstreamCredentialService` (T43), the App
 *   Work's **credential of record**: the member who created the Work and whose
 *   connection performed the fork (D2 / APW-01 FR-15). It answers
 *   `resolveForBackgroundJob(workId)` for the background jobs, reports the pause
 *   reason when the record is unusable (member left the organization, lost
 *   access, disconnected, or the scope was withdrawn), and performs the handover
 *   that makes the caller's own connection the record for work not yet started.
 *   Also exported: the store token (`UPSTREAM_CREDENTIAL_STORE`, bound by this
 *   epic's module below to the store below), the record/pause/resolution
 *   shapes its callers read, `UPSTREAM_CREDENTIAL_PAUSE_REASONS` with its
 *   `UpstreamCredentialPauseReason` union, `UPSTREAM_CREDENTIAL_I18N` (the copy
 *   table, `plan.md` §6.1), and `UpstreamCredentialNotFoundError`.
 * - `./upstream-credential.store` — `UpstreamCredentialStateStore`, the durable
 *   store that token is bound to: the record is
 *   `work_upstream_states.credentialMemberUserId` (migration
 *   `1792090000000-AddWorkUpstreamCredentialMember`), read and written through
 *   `WorkUpstreamStateRepository`. Also exported: the named refusal it throws
 *   when there is no state row to record a handover on,
 *   `UpstreamCredentialRecordUnwrittenError`.
 * - `./upstream-contribution-budget.service` — `UpstreamContributionBudgetService`
 *   (T44, FR-44/ACC-09-33): the one door every contribution run this epic
 *   dispatches goes through before it is dispatched. `book()` asks the platform's
 *   `BudgetGuardService` about **the App Work's own** `WorkBudget` and answers
 *   `allowed` or a `wait` with the reset time; `dispatch()` runs the thunk at most
 *   once, and only when the budget allowed it. Also exported: the run kinds
 *   (`UPSTREAM_CONTRIBUTION_RUN_KINDS`), the capability and plugin id the booking
 *   is made under, the wire projection T44 fixes for the write routes
 *   (`202 { state, waiting: 'budget', resetAt }` — `toUpstreamBudgetWaitResponse`
 *   with `UPSTREAM_BUDGET_WAIT_HTTP_STATUS`), `isBudgetExceededLike`, and
 *   `nextPeriodStartUtc`.
 * - `./upstream-pull-requests.module` — `UpstreamPullRequestsModule`, the module
 *   that provides the service and the store and binds the token, and the reason
 *   the binding is not a line in APW-02's `AppWorksModule` (see its docstring).
 *
 * Deliberately NOT here, because the files do not exist yet — T43 names all
 * three as **Modify** targets and each is still owned by another epic:
 * `apps/api/src/works/upstream-pull-requests.controller.ts` (APW-02's
 * `app-upstream.controller.ts` is today's read),
 * `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.tsx`
 * (APW-02's `AppUpstreamCard.tsx` renders the tab, with this epic's slot still
 * empty at `upstream/page.tsx`), and the §7 `upstream-pr-*.task.ts` jobs. The
 * credential resolution of FR-43 (the credential of record rather than a
 * Work-resolved token) can therefore not be wired into those callers yet; the
 * service, the pause semantics and the durable record it hands over through are
 * complete and tested on their own, and the record is reachable from the real
 * graph (`UpstreamPullRequestsModule` is registered in the API, so a boot with
 * the binding in place is what proves it).
 *
 * T44 is in the same position: it names `upstream-preparation.service.ts` and
 * `upstream-review-follow-up.service.ts` as **Modify** targets and neither exists
 * yet, so the budget gate is complete and tested on its own
 * (`__tests__/upstream-budget.spec.ts`) and the two callers take it as their
 * first step when they land. Nothing else can dispatch a contribution run today,
 * so there is no live caller left ungated by its absence.
 */
export * from './upstream-credential.service';
export * from './upstream-credential.store';
export * from './upstream-contribution-budget.service';
export * from './upstream-pull-requests.module';
