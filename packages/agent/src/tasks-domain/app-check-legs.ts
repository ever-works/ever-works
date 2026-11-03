import type { GitCiState, GitPullRequestCheck, GitPullRequestStatus } from '@ever-works/plugin';
import { deriveCiState, MAX_PR_CHECKS } from '@ever-works/plugin';

/**
 * APW-08 T16 (APW08-G04; FR-15, FR-16) — the required vs advisory split of an
 * App Work pull request's `Ever Works check: {name}` legs. Pure.
 *
 * ## Why the provider's roll-up is not enough
 *
 * `deriveCiState` reds on ANY completed failure, whatever the check, and the
 * merge gate only proceeds on `ciState === 'passing'`. APW-05's generated
 * workflow runs every App spec check as its own matrix leg and marks an
 * advisory one `continue-on-error: true`. Whether GitHub then reports that
 * failed leg as a FAILING check run is unverified (T16 records it as a fact to
 * check, never to assume) — so this file does not depend on the answer. It
 * reads each leg's `required` flag from the App rules at the PR base and lets
 * a failing advisory leg count for nothing in the roll-up. A provider that
 * reports the leg as failed therefore leaves the gate exactly where a provider
 * that reports it as passed would.
 *
 * ## What it never does
 *
 *  - **Green a roll-up it cannot see all of.** `status.checks` is the capped
 *    display list (`MAX_PR_CHECKS`), while `status.ciState` is the provider's
 *    roll-up over EVERY check. A failure past the cap is invisible here, so a
 *    `failing` roll-up is re-derived only when the list provably holds every
 *    check: shorter than the cap and not marked incomplete. Otherwise it stays
 *    `failing` — an advisory leg can then hold a merge, never a required one
 *    pass one.
 *  - **Touch a check that is not an App leg.** A leg is matched by its exact
 *    name, `Ever Works check: ` + the App spec `name`, AND by its REPORTER:
 *    APW-05's generated workflow runs on GitHub Actions, so a real leg is
 *    reported by {@link APP_CHECK_REPORTER_SLUG}. A name is something any app
 *    with checks-write access can choose — another app's failing run named
 *    `Ever Works check: e2e` must not be waved through as advisory — so a check
 *    from any other app, or from an unknown reporter (a commit status has no
 *    app at all), is an ordinary check and decides as it always did.
 *  - **Hide a pending leg.** An advisory leg still running keeps the roll-up
 *    `pending`: it is ignored once it FAILS, not before it has finished.
 */

/** FR-15 / R-9 — the check-run name every App spec check reports under. */
export const APP_CHECK_LEG_PREFIX = 'Ever Works check: ';

/**
 * Who reports a real App leg: APW-05's generated workflow runs every App spec
 * check as a GitHub Actions job, and GitHub reports Actions jobs as check runs
 * of the `github-actions` app (`GitPullRequestCheck.appSlug`, lower-cased by
 * the provider). Not `GITHUB_TRUSTED_CHECK_APPS`: that list says who may DRIVE
 * the fix loop, and an operator may extend it; this says who RUNS App checks,
 * and nothing else does.
 */
export const APP_CHECK_REPORTER_SLUG = 'github-actions';

/**
 * Is this check an ADVISORY App leg — the right name AND the App-check
 * reporter? An unknown reporter (`null` / absent) is NOT: fail closed, the
 * check counts as an ordinary one.
 */
export function isAdvisoryAppCheckLeg(
    check: { name?: string | null; appSlug?: string | null } | null | undefined,
    advisory: ReadonlySet<string> | null | undefined,
): boolean {
    if (!check || !advisory || typeof check.name !== 'string' || !advisory.has(check.name)) {
        return false;
    }
    return (check.appSlug ?? '').trim().toLowerCase() === APP_CHECK_REPORTER_SLUG;
}

/** `Ever Works check: type-check` for the App spec check named `type-check`. */
export function appCheckLegName(name: string): string {
    return `${APP_CHECK_LEG_PREFIX}${name}`;
}

/** The leg names of the ADVISORY checks (`required: false`) in an App rules list. */
export function advisoryAppCheckLegs(
    checks: readonly { name?: string | null; required?: boolean | null }[] | null | undefined,
): Set<string> {
    const legs = new Set<string>();
    for (const check of checks ?? []) {
        const name = typeof check?.name === 'string' ? check.name.trim() : '';
        if (name && check.required === false) legs.add(appCheckLegName(name));
    }
    return legs;
}

/** Does this status carry any App leg at all? (No leg, no rules read.) */
export function hasAppCheckLeg(
    checks: readonly { name?: string | null }[] | null | undefined,
): boolean {
    return (checks ?? []).some(
        (check) => typeof check?.name === 'string' && check.name.startsWith(APP_CHECK_LEG_PREFIX),
    );
}

/** The conclusions `deriveCiState` reds on. */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
    'failure',
    'timed_out',
    'action_required',
]);

/**
 * The CI roll-up of an App Work pull request: the provider's, with every
 * failing ADVISORY leg counted as not failing. See the module header for the
 * three things it never does. With no advisory leg the provider's own
 * `ciState` is returned untouched.
 */
export function rollUpAppCiState(
    status: Pick<GitPullRequestStatus, 'ciState' | 'checks' | 'checksComplete'>,
    advisory: ReadonlySet<string>,
): GitCiState {
    if (advisory.size === 0 || status.ciState !== 'failing') return status.ciState;
    const checks = status.checks ?? [];
    const seesEveryCheck = status.checksComplete !== false && checks.length < MAX_PR_CHECKS;
    if (!seesEveryCheck) return status.ciState;
    const effective: GitPullRequestCheck[] = checks.map((check) =>
        isAdvisoryAppCheckLeg(check, advisory) &&
        check.status === 'completed' &&
        FAILING_CONCLUSIONS.has(String(check.conclusion))
            ? { ...check, conclusion: 'neutral' }
            : check,
    );
    return deriveCiState(effective);
}

/**
 * The provider status an App Work's readers act on: `ciState` re-derived by
 * {@link rollUpAppCiState}, everything else as the provider reported it. The
 * SAME object when nothing changes, so a caller handing it on cannot tell an
 * unaffected App Work from any other.
 */
export function withAppCheckRollUp<T extends GitPullRequestStatus>(
    status: T,
    advisory: ReadonlySet<string> | null | undefined,
): T {
    if (!advisory || advisory.size === 0) return status;
    const ciState = rollUpAppCiState(status, advisory);
    return ciState === status.ciState ? status : { ...status, ciState };
}
