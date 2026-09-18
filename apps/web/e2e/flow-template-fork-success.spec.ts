/**
 * APW-13 T15 — Work Template fork succeeds (ACC-REG-02).
 *
 * ACC-REG-02's recorded verdict is *Gap — no successful fork anywhere; no
 * GitHub plugin test of the fork call*. The fork path needs the caller's GitHub
 * connection twice over: the platform forks INTO an owner the caller can write
 * to, and it clones the result with the CALLER'S token, which is the fact this
 * spec is supposed to pin (`GET /_control/calls` on the fake must show that
 * token on the fork call — T15's own "Done when").
 *
 * ── Why the success half still cannot run (re-measured 2026-09-18, after APW-01 T5):
 *
 * Three things are needed for a fork scenario, and two of them have now landed.
 * The caller's GitHub connection — **T63**, surface (b) of plan §8.8, the
 * non-production seeding route `POST /api/e2e/github-connection/seed`, reached
 * through `connectCustomerGitHub` (`helpers/github-connection.ts`). And the
 * create contract: **APW-01 T5** put `repositoryMode`, `targetOwner`,
 * `blueprintId` and `autoProvision` on `CreateWorkDto`, so `POST /api/works`
 * with the fork fields now answers **`200`** and creates a Work with
 * `kind: "app"` (probed on the lane's own API, 2026-09-18 — the `400 property
 * repositoryMode should not exist` this file used to record is gone).
 *
 * What is still missing is the third: **nothing acts on those fields yet.** The
 * service layer branches only on `isRepositoryWorkKind` — the *repo* kind —
 * (`packages/agent/src/services/work-lifecycle.service.ts:311-364`), so an
 * `app` create takes the generated-site path and `repositoryMode` /
 * `targetOwner` are dropped on the floor. T24/T25 own that wiring. The measured
 * consequence, and the reason the positive half stays behind a marker: the fake
 * GitHub records **no fork call at all** (`/_control/calls` is empty after the
 * create, not merely free of forks).
 *
 * So the marker's reason moved with the blocker rather than being removed: the
 * assertions below are unchanged, and the thing they wait for is now the
 * service layer instead of the DTO.
 *
 * ── What DOES run here, on the live stack:
 *
 *   • `POST /api/works` with the app fork fields is **accepted** — `200`, a Work
 *     row with `kind: "app"` — so the fork can now be *requested* through the
 *     create route;
 *   • the fake GitHub still records **no fork call**, because the service does
 *     not act on `repositoryMode` yet. That is the honest, runnable half of "the
 *     fork does not happen", and it is now measuring a service-layer gap rather
 *     than a missing DTO field;
 *   • the positive half — fork into the user, fork into an organization, and the
 *     fake's record of the user's token — is the fixme'd test below.
 *
 * Verified live against the lane's API (2026-09-18): the create with
 * `repositoryMode: 'fork'` and `targetOwner` answers `200` with
 * `"kind":"app","storageProvider":"user-github"`, and the fake's call log has
 * **0** entries — 0 of them forks.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const WORKS_URL = `${API_BASE}/api/works`;

/** The fake GitHub's control API (`plan §8.3`) — where the fork call must show. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** A template repository, as the fork scenarios name it. */
const TEMPLATE_URL = 'https://github.com/ever-works/templates';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface RawResult {
    status: number;
    text: string;
    json: Record<string, unknown> | null;
}

async function createWorkRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<RawResult> {
    const res = await request.post(WORKS_URL, { headers: authedHeaders(token), data: body });
    const text = await res.text();
    let json: RawResult['json'] = null;
    try {
        json = JSON.parse(text) as RawResult['json'];
    } catch {
        json = null;
    }
    return { status: res.status(), text, json };
}

/** Every call the fake has served, or `null` when it is not reachable. */
async function fakeGitHubCalls(
    request: APIRequestContext,
): Promise<Array<{ method?: string; path?: string; tokenIdentity?: string }> | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: Array<{ method?: string; path?: string }> };
        return Array.isArray(body.calls) ? body.calls : null;
    } catch {
        return null;
    }
}

test.describe('Work Template fork — the create contract accepts the fork fields', () => {
    test('a create asking to fork is accepted, and the fake still records no fork call', async ({
        request,
    }) => {
        const callsBefore = await fakeGitHubCalls(request);
        test.skip(
            callsBefore === null,
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/calls, so the ` +
                '"no fork call" half cannot be read in this run (the PR lane starts it beside the API).',
        );

        const user = await registerUserViaAPI(request);
        const created = await createWorkRaw(request, user.access_token, {
            name: `apw13-t15-fork ${stamp()}`,
            slug: `apw13-t15-fork-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
            description: 'APW-13 T15 template fork',
            organization: false,
            kind: 'app',
            repositoryUrl: TEMPLATE_URL,
            repositoryMode: 'fork',
            targetOwner: 'apw13-e2e-user',
        });

        // APW-01 T5 landed the four fields, so the validation pipe no longer refuses this body:
        // `400 property repositoryMode should not exist` is gone and the Work is created. Asserting
        // the acceptance is what makes the NEXT assertion meaningful - if the create were still
        // refused, "no fork call" would be true for the wrong reason.
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        expect(
            created.json?.work,
            'the accepted create must really have produced a Work of the app kind',
        ).toMatchObject({ kind: 'app' });

        const callsAfter = await fakeGitHubCalls(request);
        // **Fork calls, not the whole log.** The property is the one this test's
        // name states — *the fake records no fork call* — and the log is SHARED:
        // the chromium project runs spec files in parallel workers, and since
        // T63 the connected scenarios in `flow-repo-work-kind-regression` reach
        // the same fake for their `GET /user` and `GET /repos/...` reads. A
        // global before/after count therefore compares two different worlds and
        // fails on another spec's traffic; the fork filter is what the assertion
        // always meant.
        //
        // This is now the SERVICE-layer gap, not a contract gap: `repositoryMode` validates but
        // `work-lifecycle.service.ts:311-364` branches only on `isRepositoryWorkKind`, so no fork is
        // requested. When T24/T25 act on the field, this assertion is what flips.
        const forkCallsBefore = (callsBefore ?? []).filter((call) =>
            /\/forks$/.test(call.path ?? ''),
        );
        const forkCallsAfter = (callsAfter ?? []).filter((call) =>
            /\/forks$/.test(call.path ?? ''),
        );
        expect(
            forkCallsAfter.length,
            'nothing may be forked while the service ignores repositoryMode',
        ).toBe(forkCallsBefore.length);
    });
});

test.describe('Work Template fork — the success halves (T15)', () => {
    // The fork's positive contract. Both halves need a connected Git account for
    // the caller — which T63 landed (surface (b) of plan §8.8, the seeding route
    // behind `connectCustomerGitHub`) — **and** a service layer that acts on
    // `repositoryMode`. The create contract landed with APW-01 T5 (the same body
    // now answers `200` and creates the Work, asserted by the running test
    // above), but `work-lifecycle.service.ts:311-364` branches only on
    // `isRepositoryWorkKind`, so the fork call this test requires is never made.
    // The assertions are unchanged; the marker names the blocker that is
    // actually left, which is T24/T25 rather than the DTO.
    test.fixme(
        'APW-13 T15: nothing acts on repositoryMode yet — the create is accepted ' +
            '(APW-01 T5 landed the field) but the service branches only on the repo kind, ' +
            'so the fork call the fake must record is never requested (T24/T25 own that wiring)',
        async ({ request }: { request: APIRequestContext }) => {
            const user = await registerUserViaAPI(request);
            const callsBefore = await fakeGitHubCalls(request);

            // 1. Fork into the USER's own account: the fork lands under the
            //    caller's login and the Work records the upstream/repository
            //    coordinates. Then into an ORGANIZATION the caller can write
            //    to (`targetOwner`), which is the owner-picker half.
            for (const targetOwner of ['apw13-e2e-user', 'apw13-e2e-org']) {
                const created = await createWorkRaw(request, user.access_token, {
                    name: `apw13-t15-fork-${targetOwner} ${stamp()}`,
                    slug: `apw13-t15-fork-${targetOwner}-${stamp()}`
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, ''),
                    description: `APW-13 T15 fork into ${targetOwner}`,
                    organization: false,
                    kind: 'app',
                    repositoryUrl: TEMPLATE_URL,
                    repositoryMode: 'fork',
                    targetOwner,
                });
                expect(
                    created.status,
                    `fork into ${targetOwner} body=${created.text.slice(0, 300)}`,
                ).toBe(200);

                // 2. The fake recorded the FORK call, with the user's token
                //    identity on it — T15's "Done when" (`/_control/calls`
                //    records method, path and token IDENTITY, never a value).
                const calls = (await fakeGitHubCalls(request)) ?? [];
                const forkCalls = calls.filter((call) => /\/forks$/.test(call.path ?? ''));
                expect(
                    forkCalls.length,
                    `the fake must record the fork call for ${targetOwner}`,
                ).toBeGreaterThan((callsBefore ?? []).length);
                expect(
                    forkCalls.some((call) => Boolean(call.tokenIdentity)),
                    'the fork call carries a token identity — the user’s, not the estate’s',
                ).toBe(true);
            }
        },
    );
});
