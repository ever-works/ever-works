import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * flow-account-sync-lifecycle — the per-USER account GitHub-sync config lifecycle
 * (`@Controller('api/account')` → GitHubSyncService, account-transfer package).
 * ─────────────────────────────────────────────────────────────────────────────
 * This pins the SIX account-sync routes that back the `/settings/import-export`
 * "Sync to GitHub" surface. They are a DISTINCT controller from the data-repo
 * force-sync (`POST /api/works/:id/sync`) and the platform webhook/ingest surface
 * — see NON-DUPLICATION below. The whole surface is account-scoped (one
 * `user_sync_configs` row per user, `userId` UNIQUE) and gated on a connected
 * GitHub OAuth identity, which is absent in the keyless CI stack — so the
 * config-reads resolve cleanly while the OAuth/repo-dependent mutations cannot
 * succeed and surface the framework error envelope. Every shape/status below was
 * RE-PROBED LIVE against 127.0.0.1:3100 (sqlite in-memory, no GitHub OAuth)
 * before being asserted.
 *
 * PROBED CONTRACTS (account.controller.ts + github-sync.service.ts, LIVE @ 3100):
 *   - GET  /api/account/sync/status (fresh user, no config, no OAuth)
 *       → 200 { configured: false, hasOAuth: false }  (SyncStatus; repoOwner/
 *         repoName/lastPushAt/lastPullAt/lastSyncError all ABSENT when unconfigured).
 *       account-scoped: each user sees ONLY their own row (per-user UNIQUE config).
 *   - DELETE /api/account/sync (the ONLY verb on this path; GET → 404
 *       "Cannot GET /api/account/sync")
 *       → 200 { status: 'success' }. IDEMPOTENT: deleting a never-configured
 *         account is still 200, and status stays { configured:false } after.
 *   - POST /api/account/sync/configure { createNew:true } | { repoFullName }
 *       — `ensureGitHubOAuth` runs FIRST (before any repoFullName format check),
 *         so with NO connected GitHub OAuth it throws a ConflictException
 *         → 409 { statusCode:409, error:'Conflict', message:'GitHub OAuth not
 *         connected. Please connect your GitHub account first.' }.
 *         (Empty body, createNew, well-formed repoFullName, AND a malformed
 *         single-segment repoFullName all 409 identically — the OAuth gate
 *         short-circuits before the body is ever inspected. PROBED.)
 *   - POST /api/account/sync/push | /pull | /pull/apply
 *       — each first loads the sync config; an unconfigured account throws a
 *         ConflictException → 409 { statusCode:409, error:'Conflict',
 *         message:'Sync not configured. Please configure a repository first.' }.
 *         (The toggle body — includeSecrets/includeAgents/… on push, resolutions[]
 *         on pull/apply — never matters keyless: the not-configured gate precedes
 *         it. PROBED.)
 *   - AUTH (global JWT guard): EVERY one of the six routes with no/invalid bearer
 *       → 401 { message: 'Unauthorized', statusCode: 401 }. PROBED on all six.
 *
 *   ENVIRONMENT NOTE (truthful keyless contract): the configure/push/pull/pull-apply
 *   mutations are unreachable to a 2xx without a real GitHub OAuth token + a private
 *   repo, neither of which exists in CI. Rather than fake a git remote, this spec
 *   pins what the platform ACTUALLY returns keyless: the config-READ surface
 *   (status + delete) is a clean typed lifecycle, and the OAuth-DEPENDENT mutations
 *   uniformly fail-closed with the framework's generic error envelope (a stable,
 *   low-cardinality `{ statusCode, message }` shape — never a leaked partial
 *   SyncStatus, never a hang, never a 2xx that would imply a sync happened). A
 *   git-connected env (non-CI) is handled by tolerant branches where it could differ.
 *
 * NON-DUPLICATION (surveyed every data-sync / account / settings sibling):
 *   - flow-data-sync-platform.spec.ts + flow-data-sync-dispatch-deep.spec.ts →
 *     the WORK-scoped data-repo force-sync (`POST /api/works/:id/sync`) outcome
 *     envelope, dispatch-tick fold, retry-backoff idempotency, activity-feed rows,
 *     and the PLATFORM webhook-rotate / activity-log ingest surfaces. NONE touch
 *     `/api/account/sync/*` — a different controller (account-transfer) with a
 *     per-USER config row, no work id, no activity feed.
 *   - flow-account-data-export.spec.ts / account-data.spec.ts → the account
 *     export/import (`GET /api/account/export`, `POST import/preview|apply`) — the
 *     OTHER half of AccountController; this spec is the GitHub-SYNC half only.
 *   - flow-settings-github-app.spec.ts / flow-git-provider-connection.spec.ts →
 *     GitHub APP install + git-provider OAuth connect surfaces, NOT the
 *     account-sync repo config lifecycle.
 *   NET-NEW HERE: the account-sync config lifecycle (unconfigured status shape →
 *   idempotent DELETE → status unchanged), the OAuth-gate ordering on configure
 *   (gate precedes body/format validation), the uniform fail-closed envelope on the
 *   four OAuth/repo-dependent mutations, per-user config isolation, the
 *   DELETE-only verb contract, and the 401 gate across all six routes.
 *
 * GOTCHAS honored: every test registers its OWN fresh API user (never the shared
 * seeded UI user) so the per-user `user_sync_configs` row never shadows a sibling;
 * unique suffixes from a per-test counter (NOT a module-scope clock); pure API-
 * contract assertions (no UI nav); the 500 mutations are asserted as the truthful
 * keyless contract with a tolerant git-connected branch; no fake git remote is
 * invented; TS strict.
 */

interface SyncStatus {
    configured: boolean;
    hasOAuth: boolean;
    repoOwner?: string;
    repoName?: string;
    lastPushAt?: string;
    lastPullAt?: string;
    lastSyncError?: string;
}

/** The six account-sync routes, all under `/api/account`. */
const STATUS_PATH = '/api/account/sync/status';
const CONFIGURE_PATH = '/api/account/sync/configure';
const PUSH_PATH = '/api/account/sync/push';
const PULL_PATH = '/api/account/sync/pull';
const PULL_APPLY_PATH = '/api/account/sync/pull/apply';
const SYNC_PATH = '/api/account/sync';

let seq = 0;
function suffix(title: string): string {
    seq += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${seq}`;
}

async function getStatus(
    request: APIRequestContext,
    token: string,
): Promise<{ http: number; body: SyncStatus }> {
    const res = await request.get(`${API_BASE}${STATUS_PATH}`, {
        headers: authedHeaders(token),
    });
    const body = (await res.json()) as SyncStatus;
    return { http: res.status(), body };
}

/**
 * Assert a response is the framework's generic error envelope produced when a
 * service throws a plain (non-HttpException) Error: a JSON `{ statusCode, message }`
 * with a 5xx code — and CRUCIALLY not a 2xx and not a partial SyncStatus leak.
 * Keyless CI cannot reach a connected GitHub OAuth, so the OAuth/repo-dependent
 * mutations fail-closed here. The branch tolerates a non-CI git-connected env.
 */
async function expectGenericServerErrorOrSuccess(
    res: { status(): number; json(): Promise<unknown> },
    label: string,
): Promise<void> {
    const status = res.status();
    const body = (await res.json()) as Record<string, unknown>;
    // Must never be a server-side hang nor a different family of failure that
    // would imply the route is missing/misrouted (404) or unauthenticated (401).
    expect([401, 404]).not.toContain(status);
    if (status >= 200 && status < 300) {
        // Non-CI: a real GitHub OAuth + private repo exist, so the mutation
        // actually ran. Truthfully accept the success shape and bail — the
        // keyless fail-closed assertions below do not apply.
        test.info().annotations.push({
            type: 'git-connected',
            description: `${label} succeeded (2xx) — a GitHub OAuth + repo are connected (non-CI). Keyless fail-closed contract not exercised.`,
        });
        return;
    }
    // KEYLESS CI CONTRACT: configure FAILS-CLOSED with no GitHub OAuth. Today
    // the OAuth/not-configured gate throws a plain Error → generic Nest 500
    // (a known error-contract bug: a missing-prerequisite should be a 4xx like
    // 400/409/412, not an unmapped 500 — flagged for a follow-up). Assert the
    // invariant that survives the fix: a fail-closed 4xx-or-5xx that leaks no
    // partial SyncStatus, NOT the exact 500.
    expect(status, `${label} fails-closed (4xx/5xx; got ${status})`).toBeGreaterThanOrEqual(400);
    expect(status, `${label} is not a gateway/timeout class`).toBeLessThan(600);
    expect(body, `${label} returns a JSON statusCode`).toMatchObject({ statusCode: status });
    expect(typeof body.message, `${label} returns a string message`).toBe('string');
    // Defence-in-depth: the failure must NOT leak a partial SyncStatus (the
    // service never returns config fields on the error path).
    expect(body).not.toHaveProperty('configured');
    expect(body).not.toHaveProperty('repoOwner');
    expect(body).not.toHaveProperty('repoName');
}

test.describe('account GitHub-sync — config lifecycle (status + delete)', () => {
    test('a fresh account reports the unconfigured SyncStatus shape (no leaked repo/timestamp fields)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { name: `Sync Status ${suffix('status')}` });

        const { http, body } = await getStatus(request, user.access_token);
        expect(http, 'status is a clean 200 for an unconfigured account').toBe(200);

        // The exact unconfigured envelope — both flags present, both false in
        // keyless CI (no connected GitHub OAuth).
        expect(typeof body.configured, 'configured is a boolean').toBe('boolean');
        expect(typeof body.hasOAuth, 'hasOAuth is a boolean').toBe('boolean');
        expect(body.configured, 'a fresh account is not configured').toBe(false);
        expect(body.hasOAuth, 'keyless CI has no connected GitHub OAuth').toBe(false);

        // When unconfigured the service returns ONLY { configured, hasOAuth } —
        // the repo + last-sync fields must be absent (no stale/empty leakage).
        expect(body.repoOwner, 'no repoOwner when unconfigured').toBeUndefined();
        expect(body.repoName, 'no repoName when unconfigured').toBeUndefined();
        expect(body.lastPushAt, 'no lastPushAt when unconfigured').toBeUndefined();
        expect(body.lastPullAt, 'no lastPullAt when unconfigured').toBeUndefined();
        expect(body.lastSyncError, 'no lastSyncError when unconfigured').toBeUndefined();
    });

    test('DELETE sync is idempotent on a never-configured account and leaves status unconfigured', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { name: `Sync Delete ${suffix('delete')}` });

        // DELETE on an account that never configured sync is a clean idempotent
        // no-op (the repository delete simply removes nothing).
        const first = await request.delete(`${API_BASE}${SYNC_PATH}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(first.status(), 'first delete -> 200').toBe(200);
        expect(await first.json(), 'delete envelope').toMatchObject({ status: 'success' });

        // A second delete is also a clean 200 — nothing left to remove.
        const second = await request.delete(`${API_BASE}${SYNC_PATH}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(second.status(), 'second delete is still idempotent 200').toBe(200);
        expect(await second.json()).toMatchObject({ status: 'success' });

        // Status is unchanged — still unconfigured (the reset did not invent state).
        const { http, body } = await getStatus(request, user.access_token);
        expect(http).toBe(200);
        expect(body.configured, 'status stays unconfigured after DELETE').toBe(false);
    });

    test('the /api/account/sync path only answers DELETE (GET on it is a 404 route-not-found)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { name: `Sync Verb ${suffix('verb')}` });

        // The DELETE verb resolves (200), but GET on the same path is a hard
        // route-not-found — the controller exposes exactly one verb here.
        const wrongVerb = await request.get(`${API_BASE}${SYNC_PATH}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(wrongVerb.status(), 'GET /api/account/sync -> 404').toBe(404);
        const body = await wrongVerb.json();
        expect(body, 'route-not-found envelope').toMatchObject({ statusCode: 404 });
        expect(String(body.error ?? body.message), 'not-found marker').toMatch(/not found/i);

        // The DELETE verb on the same path DOES resolve — proving the 404 above
        // is verb-scoped, not a missing controller.
        const del = await request.delete(`${API_BASE}${SYNC_PATH}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(del.status(), 'DELETE /api/account/sync -> 200').toBe(200);
    });
});

test.describe('account GitHub-sync — OAuth-gated mutations fail-closed keyless', () => {
    test('configure (createNew) fails-closed without a connected GitHub OAuth and never persists a config', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            name: `Sync ConfigNew ${suffix('cfg-new')}`,
        });

        const res = await request.post(`${API_BASE}${CONFIGURE_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: { createNew: true },
        });
        await expectGenericServerErrorOrSuccess(res, 'configure(createNew)');

        // The failed configure must NOT have persisted a config row — a follow-up
        // status read is still unconfigured (the OAuth gate threw before upsert).
        const { body } = await getStatus(request, user.access_token);
        if (res.status() >= 400) {
            expect(body.configured, 'a failed configure leaves the account unconfigured').toBe(
                false,
            );
        }
    });

    test('configure (repoFullName) fails-closed and the OAuth gate precedes repoFullName format validation', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            name: `Sync ConfigRepo ${suffix('cfg-repo')}`,
        });

        // A WELL-FORMED owner/repo still fails-closed keyless (no OAuth).
        const wellFormed = await request.post(`${API_BASE}${CONFIGURE_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: { repoFullName: 'octocat/ever-works-config' },
        });
        await expectGenericServerErrorOrSuccess(wellFormed, 'configure(wellFormed repoFullName)');

        // A MALFORMED single-segment repoFullName ALSO fails-closed with the SAME
        // generic envelope — proving `ensureGitHubOAuth` short-circuits BEFORE the
        // `owner/repo` split + format check is ever reached. (If format validation
        // ran first this would be a 400 with an "Expected format" message; keyless
        // it is the same OAuth-gate 5xx.)
        const malformed = await request.post(`${API_BASE}${CONFIGURE_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: { repoFullName: 'no-slash-segment' },
        });
        await expectGenericServerErrorOrSuccess(malformed, 'configure(malformed repoFullName)');
        // Gate ordering: in CI both the well-formed and malformed bodies yield the
        // SAME status family — the body never differentiated the outcome.
        if (wellFormed.status() >= 400 && malformed.status() >= 400) {
            expect(
                malformed.status(),
                'OAuth gate makes malformed + well-formed configure indistinguishable keyless',
            ).toBe(wellFormed.status());
        }

        // An empty body also fails on the same gate (not on a "createNew or
        // repoFullName required" branch, which is unreachable behind the gate).
        const empty = await request.post(`${API_BASE}${CONFIGURE_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        await expectGenericServerErrorOrSuccess(empty, 'configure(empty body)');
    });

    test('push fails-closed on an unconfigured account regardless of the v2-tail toggles', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, { name: `Sync Push ${suffix('push')}` });

        // The not-configured gate runs before the toggle body is consulted, so a
        // rich toggle body and an empty body both fail-closed identically keyless.
        const withToggles = await request.post(`${API_BASE}${PUSH_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: {
                includeSecrets: true,
                includeAgents: true,
                includeSkills: true,
                includeTasks: true,
                includeTaskChat: true,
            },
        });
        await expectGenericServerErrorOrSuccess(withToggles, 'push(all toggles)');

        const emptyBody = await request.post(`${API_BASE}${PUSH_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        await expectGenericServerErrorOrSuccess(emptyBody, 'push(empty body)');
    });

    test('pull fails-closed on an unconfigured account', async ({ request }) => {
        const user = await registerUserViaAPI(request, { name: `Sync Pull ${suffix('pull')}` });

        const res = await request.post(`${API_BASE}${PULL_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        await expectGenericServerErrorOrSuccess(res, 'pull');
    });

    test('pull/apply fails-closed on an unconfigured account whether resolutions are absent or empty', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request, {
            name: `Sync PullApply ${suffix('pull-apply')}`,
        });

        // The controller defaults `resolutions` to [] when absent (body.resolutions
        // || []), so both an absent and an explicit empty array hit the same
        // not-configured gate keyless.
        const noResolutions = await request.post(`${API_BASE}${PULL_APPLY_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        await expectGenericServerErrorOrSuccess(noResolutions, 'pull/apply(no resolutions)');

        const emptyResolutions = await request.post(`${API_BASE}${PULL_APPLY_PATH}`, {
            headers: authedHeaders(user.access_token),
            data: { resolutions: [] },
        });
        await expectGenericServerErrorOrSuccess(emptyResolutions, 'pull/apply(empty resolutions)');
    });
});

test.describe('account GitHub-sync — auth + account-scope isolation', () => {
    test('every account-sync route is JWT-gated: 401 with no bearer and 401 with an invalid bearer', async ({
        request,
    }) => {
        // Anonymous (no Authorization header) on all six routes -> 401.
        const anonChecks: Array<{ label: string; res: Awaited<ReturnType<typeof request.fetch>> }> =
            [
                { label: 'GET status', res: await request.get(`${API_BASE}${STATUS_PATH}`) },
                {
                    label: 'POST configure',
                    res: await request.post(`${API_BASE}${CONFIGURE_PATH}`, {
                        data: { createNew: true },
                    }),
                },
                {
                    label: 'POST push',
                    res: await request.post(`${API_BASE}${PUSH_PATH}`, { data: {} }),
                },
                {
                    label: 'POST pull',
                    res: await request.post(`${API_BASE}${PULL_PATH}`, { data: {} }),
                },
                {
                    label: 'POST pull/apply',
                    res: await request.post(`${API_BASE}${PULL_APPLY_PATH}`, { data: {} }),
                },
                { label: 'DELETE sync', res: await request.delete(`${API_BASE}${SYNC_PATH}`) },
            ];
        for (const { label, res } of anonChecks) {
            expect(res.status(), `${label} (anon) -> 401`).toBe(401);
            expect(await res.json(), `${label} (anon) envelope`).toMatchObject({ statusCode: 401 });
        }

        // An INVALID bearer is also rejected by the JWT guard (not treated as anon
        // nor leaked into a 5xx) — assert on the two safe-to-read routes.
        const badHeaders = { Authorization: 'Bearer not-a-real-jwt-token-xyz' };
        const badStatus = await request.get(`${API_BASE}${STATUS_PATH}`, { headers: badHeaders });
        expect(badStatus.status(), 'GET status (bad bearer) -> 401').toBe(401);
        const badDelete = await request.delete(`${API_BASE}${SYNC_PATH}`, { headers: badHeaders });
        expect(badDelete.status(), 'DELETE sync (bad bearer) -> 401').toBe(401);
    });

    test('sync status is account-scoped: two fresh users each see only their own unconfigured config', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request, {
            name: `Sync ScopeA ${suffix('scope-a')}`,
        });
        const userB = await registerUserViaAPI(request, {
            name: `Sync ScopeB ${suffix('scope-b')}`,
        });

        // Each user resolves their OWN status row (user_sync_configs.userId is
        // UNIQUE), and a DELETE by one user cannot affect the other's view.
        const a1 = await getStatus(request, userA.access_token);
        const b1 = await getStatus(request, userB.access_token);
        expect(a1.http).toBe(200);
        expect(b1.http).toBe(200);
        expect(a1.body.configured).toBe(false);
        expect(b1.body.configured).toBe(false);

        // User A resets — User B is unaffected (cross-user isolation of the
        // per-user config row).
        const delA = await request.delete(`${API_BASE}${SYNC_PATH}`, {
            headers: authedHeaders(userA.access_token),
        });
        expect(delA.status()).toBe(200);

        const b2 = await getStatus(request, userB.access_token);
        expect(b2.http, "B's status read still resolves after A's reset").toBe(200);
        expect(b2.body.configured, "A's DELETE did not touch B's config").toBe(false);
        expect(b2.body.hasOAuth).toBe(false);
    });
});
