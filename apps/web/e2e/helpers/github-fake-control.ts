/**
 * Arming the fake GitHub's refusals from a spec (APW-13 T2's `_control` API).
 *
 * ## Why this module exists
 *
 * The fake answers `GET /user` with the `user` fixture **for every token**
 * (`fakes/github-fake/routes/repos.mjs`, asserted 200 by
 * `__tests__/contract.unit.spec.ts`), which is what makes it a faithful stand-in
 * for a *working* credential and a useless one for a **dead** one. A spec that
 * means to prove "this token is dead, so this surface refuses" must therefore
 * **arm the refusal itself**; leaving it to the default gets the request through
 * the identity gate and red on whichever gate comes next
 * (`gh_repo_access_denied` from `assertRepoAccess`, not `gh_credential_invalid`
 * from `resolveGitHubIdentity`). That is the C14 fidelity gap in
 * `docs/internal/app-works-build-progress.md`, and this helper is where the
 * arming idiom lives so the next spec author finds it rather than re-deriving
 * it.
 *
 * ## The two semantics a caller must respect
 *
 *   1. **A fault applies to the NEXT MATCHING CALL, then is restored**
 *      (`times` defaults to 1; `state.mjs` drops the entry when its last
 *      application is spent). So a fault belongs in **per-case setup**,
 *      immediately before the request that needs it — never once in
 *      `global-setup` and never once for a whole file. The fake is one process
 *      shared by every worker and every spec file, so any matching call from
 *      anywhere consumes the fault.
 *   2. **Narrowing is by `tokenValue`, not by `token`.** `token` matches the
 *      token **identity** the fake resolved — and a dead token has none, because
 *      the fake never seeded it, so every unseeded token collapses to the single
 *      identity `unknown`. {@link armAuthRefusedForToken} therefore arms
 *      `tokenValue`, which pins the fault to the exact presented token: a second
 *      lane arming its own dead token cannot steal it, and a third party's dead
 *      token cannot absorb it.
 *
 * ## What it proves, not just does
 *
 * {@link armAuthRefusedForToken} **re-reads `/_control/faults`** and refuses if
 * the fault is not armed, and {@link assertTokenRefusedOnce} **re-reads
 * `/_control/calls`** and requires a call carrying `faultApplied:
 * 'auth-refused'` with `status: 401`. Together those turn "the case returned
 * `gh_credential_invalid`" into "the case returned `gh_credential_invalid`
 * **because the fake refused that token**" — the assertion a dead-token case is
 * actually making.
 */

import { type APIRequestContext } from '@playwright/test';

/** One entry of `GET /_control/calls`, as the fake records it. */
export interface FakeGitHubCall {
    method: string;
    path: string;
    /** The login the fake resolved, or `anonymous` / `unknown`. Never a value. */
    tokenIdentity: string;
    authenticated: boolean;
    /** The behaviour a planted fault answered with, or `null`. */
    faultApplied: string | null;
    status: number | null;
    at: string;
}

/** The refusal behaviour this helper plants (`state.mjs`'s vocabulary). */
export const AUTH_REFUSED = 'auth-refused';

/** The status `auth-refused` answers with by default — GitHub's own 401. */
export const AUTH_REFUSED_STATUS = 401;

function base(fakeUrl: string): string {
    return fakeUrl.replace(/\/+$/, '');
}

/**
 * Is a fake GitHub answering this origin's control API?
 *
 * Shape-probed rather than assumed: a live lane leaves `APW_E2E_GITHUB_FAKE_URL`
 * unset (so this defaults to the fake's own 3900) and something else may own
 * that port, and a control API answered by *not* the fake is worse than none —
 * the case would arm a fault nobody reads and pass for the wrong reason.
 */
export async function isFakeGitHubReachable(
    request: APIRequestContext,
    fakeUrl: string,
): Promise<boolean> {
    try {
        const [calls, state] = await Promise.all([
            request.get(`${base(fakeUrl)}/_control/calls`, { failOnStatusCode: false }),
            request.get(`${base(fakeUrl)}/_control/state`, { failOnStatusCode: false }),
        ]);
        if (!calls.ok() || !state.ok()) return false;
        const callBody = (await calls.json()) as { calls?: unknown };
        const stateBody = (await state.json()) as { repositories?: unknown };
        return Array.isArray(callBody.calls) && Array.isArray(stateBody.repositories);
    } catch {
        return false;
    }
}

/** What {@link armDeadTokenRefusal} arranged, and what the case must still prove. */
export type DeadTokenRefusal =
    /** The lane runs a fake, and the one-shot refusal for `token` is armed. */
    | { lane: 'fake-github'; callsBefore: number }
    /** The lane has no fake; the platform's own GitHub call is the refusal. */
    | { lane: 'no-fake' };

/**
 * The **per-case setup** for a case whose subject is a dead credential.
 *
 * A case is dead-token-shaped whether or not the lane runs a fake, and the two
 * lanes refuse for different reasons, so this helper does the one thing the case
 * cannot know by itself:
 *
 *   - **a fake lane** — the fake answers `GET /user` 200 for *every* token, so
 *     nothing is dead until a fault says so. Arm the one-shot refusal for
 *     exactly this token, and remember the call-log index so the proof step can
 *     tell this case's refusal from an earlier one's.
 *   - **a lane with no fake** — the platform's GitHub call goes to the real
 *     service with a bogus token, which refuses it. Nothing to arm; the case's
 *     existing assertion already measures the intended gate.
 *
 * Call it immediately before the request under test, then hand the result to
 * {@link assertDeadTokenRefusalProven} after it.
 */
export async function armDeadTokenRefusal(
    request: APIRequestContext,
    fakeUrl: string,
    token: string,
): Promise<DeadTokenRefusal> {
    if (!(await isFakeGitHubReachable(request, fakeUrl))) return { lane: 'no-fake' };
    const callsBefore = (await readFakeCalls(request, fakeUrl)).length;
    await armAuthRefusedForToken(request, fakeUrl, { token });
    return { lane: 'fake-github', callsBefore };
}

/**
 * The half of the case that says **why** the platform refused, for whichever
 * lane {@link armDeadTokenRefusal} found. A no-op without a fake, because there
 * the refusal *is* the real GitHub's and there is no fake log to read.
 */
export async function assertDeadTokenRefusalProven(
    request: APIRequestContext,
    fakeUrl: string,
    refusal: DeadTokenRefusal,
): Promise<FakeGitHubCall | null> {
    if (refusal.lane === 'no-fake') return null;
    return assertTokenRefusedOnce(request, fakeUrl, { notBefore: refusal.callsBefore });
}

/**
 * Plant a one-shot `auth-refused` on `route` (default `/user`) for exactly the
 * token **value** given, and assert the fake is now armed.
 *
 * Call it in the case's own setup, immediately before the request under test.
 */
export async function armAuthRefusedForToken(
    request: APIRequestContext,
    fakeUrl: string,
    options: { token: string; route?: string; status?: number },
): Promise<void> {
    const route = options.route ?? '/user';
    const response = await request.post(`${base(fakeUrl)}/_control/fault`, {
        data: {
            route,
            behaviour: AUTH_REFUSED,
            tokenValue: options.token,
            ...(options.status === undefined ? {} : { status: options.status }),
        },
        failOnStatusCode: false,
    });
    const text = await response.text().catch(() => '');
    if (response.status() !== 200) {
        throw new Error(
            `C14: the fake GitHub at ${base(fakeUrl)} refused POST /_control/fault ` +
                `(HTTP ${response.status()}): ${text.slice(0, 300)}. Without the armed fault the ` +
                'dead-token case cannot reach its intended gate, so this is a lane failure, not ' +
                'a scenario failure.',
        );
    }

    // A 200 is not evidence that the fault is armed: `takeFault` drops a spent
    // entry, and a spec re-running a case would otherwise read a stale answer.
    const listed = await request.get(`${base(fakeUrl)}/_control/faults`, {
        failOnStatusCode: false,
    });
    const armed = listed.ok()
        ? (((await listed.json()) as { faults?: unknown[] }).faults ?? [])
        : [];
    const found = armed.some((entry) => {
        const fault = entry as { route?: string; behaviour?: string; tokenValue?: string };
        return (
            fault.route === route &&
            fault.behaviour === AUTH_REFUSED &&
            fault.tokenValue === options.token
        );
    });
    if (!found) {
        throw new Error(
            `C14: POST /_control/fault answered 200 but the fake at ${base(fakeUrl)} does not ` +
                `report an armed { route: '${route}', behaviour: '${AUTH_REFUSED}', tokenValue } — ` +
                `it lists ${JSON.stringify(armed).slice(0, 300)}. A fault is one-shot and is spent ` +
                'by the next matching call, so an already-spent plant means this case is about to ' +
                'assert whichever gate the permissive default reaches instead.',
        );
    }
}

/** Every call the fake recorded, oldest first. */
export async function readFakeCalls(
    request: APIRequestContext,
    fakeUrl: string,
): Promise<FakeGitHubCall[]> {
    const response = await request.get(`${base(fakeUrl)}/_control/calls`, {
        failOnStatusCode: false,
    });
    if (!response.ok()) {
        throw new Error(
            `C14: the fake GitHub at ${base(fakeUrl)} is not answering /_control/calls ` +
                `(HTTP ${response.status()}), so the call log cannot prove which fault fired.`,
        );
    }
    const body = (await response.json()) as { calls?: FakeGitHubCall[] };
    return body.calls ?? [];
}

/**
 * Assert the fake answered `route` for the armed token with the planted
 * refusal, and return that call.
 *
 * This is the half of a dead-token case that says **why** the platform refused:
 * without it, `expect(body.code).toBe('gh_credential_invalid')` would also pass
 * against a stack whose fake refused everything for an unrelated reason.
 *
 * `notBefore` is the call-log index the case started from — read it with
 * {@link readFakeCalls} before arming, so an earlier case's refusal cannot be
 * mistaken for this one's. The log records the token **identity** and never its
 * value, so this pairs with {@link armAuthRefusedForToken}'s by-value arming
 * rather than re-checking the value here.
 */
export async function assertTokenRefusedOnce(
    request: APIRequestContext,
    fakeUrl: string,
    options: { route?: string; notBefore?: number } = {},
): Promise<FakeGitHubCall> {
    const route = options.route ?? '/user';
    const calls = await readFakeCalls(request, fakeUrl);
    const notBefore = options.notBefore ?? 0;
    const refused = calls.find(
        (call, index) =>
            index >= notBefore &&
            call.path === route &&
            call.faultApplied === AUTH_REFUSED &&
            call.status === AUTH_REFUSED_STATUS,
    );
    if (!refused) {
        throw new Error(
            `C14: the fake GitHub at ${base(fakeUrl)} never refused ${route} with ` +
                `${AUTH_REFUSED_STATUS} for the dead token. Its call log from index ${notBefore} is ` +
                `${JSON.stringify(calls.slice(notBefore)).slice(0, 600)}. Either the fault was not ` +
                'armed in this case, or it was spent by another call before this one — and in ' +
                'both readings the platform refusal below was produced by a different gate than ' +
                'the dead credential.',
        );
    }
    return refused;
}
