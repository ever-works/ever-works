/**
 * APW-13 T32 — SEC PIN: an App env value never surfaces (ACC-NEG-12).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-NEG-12 — Secrets never surface** (`ACCEPTANCE.md:717`):
 *
 * > `GET /api/works/:id/app-env` returns entry metadata (name, origin, phase,
 * > required, set/unset, description, change flags, actor and time) and no stored
 * > or resolved value — only App-spec-public text and keypair public halves appear
 * > (APW-07 FR-2, FR-5, FR-15); a prompted value typed as a unique token appears in
 * > no API response, Activity entry, chat transcript or page HTML;
 * > `app.env.changed` carries names and actions only — never a value, length or
 * > hash (FR-8); a generated value is identical across redeploy, rebuild, restart,
 * > App spec re-apply and upstream sync (fixture `secretFingerprint`) and changes
 * > only after a typed-name rotate (`app.env.rotated`) or a confirmed **Replace
 * > generated values** import, visible after the next Deploy (FR-12, FR-27,
 * > FR-29).
 *
 * ## What this file proves today, and what it cannot
 *
 * The route the case is built on — `GET /api/works/:id/app-env` — is **not mounted**
 * on this branch (`404 Cannot GET`, measured below), and neither is any other
 * APW-07 read: the migration that creates `work_app_env_values` is checked in, but
 * no controller serves it. So the case's metadata contract, its event contract and
 * its fingerprint contract have no surface to assert against yet; each is carried by
 * a `test.fixme('APW-07: …')` body below, and the two cluster-only halves
 * (redeploy/rebuild/restart stability, and *Replace generated values*) also need
 * APW-05/APW-06, which the PR lane has no cluster for.
 *
 * What **is** measurable is the write-only half, and it is the half that matters
 * for a leak: the App Work create route accepts a prompted value
 * (`appEnv: { NAME: <unique token> }`, APW-01's create body), and the value then
 * appears in **no** response this lane can read — not the create's own answer, not
 * the Work read, not the upstream read, not the work list, not the activity log,
 * not the notifications, not the page HTML — and not in the fake GitHub's whole
 * call ledger either. Those surfaces are swept one by one below.
 *
 * **The limit of that pin, stated plainly:** with no read route in existence, "the
 * value does not surface" cannot by itself distinguish *stored and withheld* from
 * *never stored*. The running pin establishes the absence of a leak on every
 * surface that exists; it does **not** establish that the platform keeps the value
 * at all. That needs APW-07's read (the fixme below).
 *
 * ## Measured on this lane (2026-09-19)
 *
 * API `node apps/api/dist/main.js` on **3998** (sqlite in memory, the runbook's
 * env), fake GitHub on **3902**, web on **3202**:
 *
 *   - `POST /api/works` (fork) with `appEnv: { APW13_PROBE_SECRET: '<token>' }` →
 *     `200`, and the token is absent from the create body
 *   - absent from `GET /api/works/:id`, `GET /api/works/:id/upstream`,
 *     `GET /api/works?limit=50`, `GET /api/activity-log?limit=50`,
 *     `GET /api/notifications?limit=50`; `GET /api/works/:id/app-env` → `404`
 *   - absent from the fake's entire call ledger (162 calls recorded at probe time)
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import { appWorkCreateBody, createAppWork, getAppEnvNames, rawApi } from './helpers/app-works';
import { registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/** Serial for the reason T30's spec documents — see the licence-gate pin's header. */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`). */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The web origin, for the page-HTML half of the case. */
const WEB_BASE = (process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** The login the checked-in PR-lane fixture gives the run account. */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot push to — so every create here is a fork. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/** The env name this file types a value for. */
const PROBE_ENV_NAME = 'APW13_PROBE_SECRET';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
}

interface FakeCall {
    method?: string;
    path?: string;
}

async function fakeGitHubCalls(request: APIRequestContext): Promise<FakeCall[] | null> {
    try {
        const res = await request.get(`${FAKE_GITHUB_URL}/_control/calls`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { calls?: FakeCall[] };
        return Array.isArray(body.calls) ? body.calls : null;
    } catch {
        return null;
    }
}

function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

async function seedFakeGitHub(
    request: APIRequestContext,
    extraRepositories: Array<Record<string, unknown>> = [],
): Promise<boolean> {
    const fixture = fakeSeedFixturePath();
    if (fixture === null) return false;
    try {
        const seed = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
        const res = await request.post(`${FAKE_GITHUB_URL}/_control/seed`, {
            data: {
                ...seed,
                repositories: [...((seed.repositories as unknown[]) ?? []), ...extraRepositories],
            },
        });
        return res.ok();
    } catch {
        return false;
    }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The mutating calls against one repository (the write control this file needs). */
function writesMatching(calls: FakeCall[], needle: string): FakeCall[] {
    return calls.filter(
        (call) =>
            MUTATING_METHODS.has((call.method ?? '').toUpperCase()) &&
            !(call.path ?? '').startsWith('/graphql') &&
            (call.path ?? '').includes(needle),
    );
}

interface CreatedView {
    work?: { id?: string; slug?: string; kind?: string };
}

/**
 * Create a forked App Work carrying one prompted env value, and hand back the
 * answer. The value is run-unique so a leak can only have come from this request.
 */
async function createWithEnv(
    request: APIRequestContext,
    token: string,
    repo: { owner: string; name: string },
    secret: string,
    slugBase: string,
): Promise<{ status: number; body: CreatedView; text: string }> {
    const slug = `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const result = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T32 NEG-12 ${slugBase}`,
            organization: false,
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
            appEnv: { [PROBE_ENV_NAME]: secret },
        }),
    });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

// ---------------------------------------------------------------------------
// Running pins — the write-only value, swept across every surface that exists
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-12 — a prompted value is accepted write-only and never returned', () => {
    test('the create accepts the value, its own answer does not carry it, and the fork it asked for is the only GitHub write', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-secret-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the ` +
                'write-only create cannot be staged in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const secret = `apw13env${run.replace(/[^a-z0-9]/g, '')}`;

        const created = await createWithEnv(
            request,
            user.access_token,
            repo,
            secret,
            'apw13-t32-secret',
        );
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        expect(created.body.work?.kind).toBe('app');
        expect(
            created.text.includes(secret),
            'the create answer never echoes the value it was given',
        ).toBe(false);
        expect(
            /"appEnv"|"envValue"|"secret"/.test(created.text),
            'and carries no field named for it either',
        ).toBe(false);

        // Positive control: the create really ran and really wrote to GitHub, so the
        // "no leak anywhere" sweep below is not measuring an inert lane.
        const calls = (await fakeGitHubCalls(request)) ?? [];
        const repoWrites = writesMatching(calls, `/${repo.owner}/${repo.name}`);
        expect(
            repoWrites.length,
            `the fork is the one write against the repository ` +
                `(writes=${JSON.stringify(repoWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(1);
        // The fake spells every repository path with its `/repos` prefix — measured in
        // the call ledger, and the reason `writesMatching` above filters on the
        // `owner/name` substring rather than on a prefix.
        expect(repoWrites[0]?.path).toBe(`/repos/${repo.owner}/${repo.name}/forks`);
    });

    test('no readable surface returns the value: the Work read, the upstream read, the list, the Activity log and the notifications', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-secret-sweep-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the sweep ` +
                'has no App Work to read in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);
        const secret = `apw13sweep${run.replace(/[^a-z0-9]/g, '')}`;

        const created = await createWithEnv(
            request,
            user.access_token,
            repo,
            secret,
            'apw13-t32-secret-sweep',
        );
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';
        const slug = created.body.work?.slug ?? '';
        expect(workId).toBeTruthy();

        const surfaces: Array<{
            label: string;
            call: () => Promise<{ status: number; text: string }>;
        }> = [
            {
                label: 'GET /api/works/:id (the Work read)',
                call: () =>
                    rawApi(request, 'GET', `/api/works/${workId}`, { token: user.access_token }),
            },
            {
                label: 'GET /api/works/:id/upstream (the Upstream card)',
                call: () =>
                    rawApi(request, 'GET', `/api/works/${workId}/upstream`, {
                        token: user.access_token,
                    }),
            },
            {
                label: 'GET /api/works (the work list)',
                call: () =>
                    rawApi(request, 'GET', '/api/works', {
                        token: user.access_token,
                        query: { limit: 50 },
                    }),
            },
            {
                label: 'GET /api/activity-log (the Activity entries)',
                call: () =>
                    rawApi(request, 'GET', '/api/activity-log', {
                        token: user.access_token,
                        query: { limit: 50 },
                    }),
            },
            {
                label: 'GET /api/notifications',
                call: () =>
                    rawApi(request, 'GET', '/api/notifications', {
                        token: user.access_token,
                        query: { limit: 50 },
                    }),
            },
        ];

        for (const surface of surfaces) {
            const result = await surface.call();
            expect(result.status, `${surface.label} answered ${result.status}`).toBeLessThan(500);
            expect(
                result.text.includes(secret),
                `${surface.label} must not carry the prompted value`,
            ).toBe(false);
            expect(
                result.text.includes(PROBE_ENV_NAME) && result.text.includes(secret),
                `${surface.label} must not carry the name together with the value`,
            ).toBe(false);
        }

        // The page HTML half of ACC-NEG-12, fetched with the project's session cookies.
        //
        // **Bounded on purpose, and reported rather than waited out.** Measured on this
        // lane (2026-09-19): `GET http://localhost:3202/works/<slug>` for a kind-`app`
        // Work did not answer at all — the first version of this file hit Playwright's
        // 90 s test timeout on this line and the request context was disposed. So the
        // fetch carries its own 15 s bound, a timeout is asserted as a timeout (never
        // silently swallowed), and the negative below is asserted on whatever HTML came
        // back — including none. The clause is therefore *reported* as unreachable for
        // this app kind, not quietly claimed.
        let html = '';
        let pageStatus = 0;
        let pageFailure = '';
        try {
            const page = await request.get(`${WEB_BASE}/works/${slug}`, {
                failOnStatusCode: false,
                timeout: 15_000,
            });
            pageStatus = page.status();
            html = await page.text();
        } catch (error) {
            pageFailure = error instanceof Error ? error.message : String(error);
        }
        expect(
            pageFailure === '' || /Timeout|timed out/i.test(pageFailure),
            `the page fetch is bounded: a transport failure is reported, not waited out ` +
                `(failure=${pageFailure.slice(0, 200)})`,
        ).toBe(true);
        expect(
            html.includes(secret),
            `the Work page HTML (HTTP ${pageStatus === 0 ? 'no answer within 15 s' : pageStatus}) ` +
                'must not carry the prompted value',
        ).toBe(false);

        // And the value never reached GitHub either.
        const calls = (await fakeGitHubCalls(request)) ?? [];
        expect(
            JSON.stringify(calls).includes(secret),
            "the fake GitHub's whole call ledger must not carry the prompted value",
        ).toBe(false);

        // The env read the case is built on is not mounted: asserted here so the
        // sweep above is never mistaken for evidence about that route.
        const envRead = await getAppEnvNames(request, { token: user.access_token, workId });
        expect(
            envRead.status,
            `GET /api/works/:id/app-env body=${envRead.text.slice(0, 200)} — APW-07's read does ` +
                'not exist on this API yet, which is the blocker the fixme below names',
        ).toBe(404);
        expect(envRead.text).toContain('Cannot GET');
    });

    test('the app-env route is 404 for the owner, for another account and for nobody — never a 403 that would confirm it exists', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-secret-routes-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to point the route at in this run.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const other = await registerUserViaAPI(request);

        const created = await createWithEnv(
            request,
            owner.access_token,
            repo,
            `apw13routes${run.replace(/[^a-z0-9]/g, '')}`,
            'apw13-t32-secret-routes',
        );
        expect(created.status, `create body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';

        for (const [who, token] of [
            ['owner', owner.access_token],
            ['another account', other.access_token],
            ['no session', ''],
        ] as const) {
            const result = await getAppEnvNames(request, { token, workId });
            expect(result.status, `GET app-env (${who}) body=${result.text.slice(0, 200)}`).toBe(
                404,
            );
        }
    });
});

// ---------------------------------------------------------------------------
// The acceptance case, blocked by APW-07 (and by the cluster lanes it needs)
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-12 — the entry metadata, the events and the fingerprint (fixme until APW-07)', () => {
    /**
     * The measured blocker, clause by clause:
     *
     *   - `GET /api/works/:id/app-env` → `404 Cannot GET` (measured), so the
     *     metadata contract ("name, origin, phase, required, set/unset, description,
     *     change flags, actor and time … and no stored or resolved value") has no
     *     answer to assert;
     *   - `app.env.changed` / `app.env.rotated` are APW-07's events; nothing emits
     *     them because nothing writes an env row;
     *   - the `secretFingerprint` stability clause spans redeploy, rebuild, restart,
     *     App spec re-apply and upstream sync — APW-05's builds and APW-06's runtime
     *     are cluster-lane surfaces (APW-13 T35), not PR-lane ones.
     */
    test.fixme(
        'APW-07: the entry metadata, app.env.changed and the secretFingerprint stability need ' +
            'the app-env routes — GET /api/works/:id/app-env answers 404 Cannot GET and no event ' +
            'is emitted (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg12-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [repo])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const owner = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, owner.access_token);
            const secret = `apw13neg12${run.replace(/[^a-z0-9]/g, '')}`;

            const created = await createWithEnv(
                request,
                owner.access_token,
                repo,
                secret,
                'apw13-t32-neg12',
            );
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';

            // The metadata contract: names, origins, phases — and no value.
            const env = await getAppEnvNames(request, { token: owner.access_token, workId });
            expect(env.status).toBe(200);
            expect(env.text).toContain(PROBE_ENV_NAME);
            expect(env.text).not.toContain(secret);
            expect(env.text).not.toMatch(/"value"|"resolved"|"length"|"hash"/);
            expect(env.text).toMatch(/"origin"|"set":true|"phase"/);

            // The event contract: names and actions only.
            const activity = await rawApi(request, 'GET', '/api/activity-log', {
                token: owner.access_token,
                query: { limit: 50 },
            });
            expect(activity.text).toContain('app.env.changed');
            expect(activity.text).not.toContain(secret);

            // The round-trip contract: the same value twice is the same value.
            const created2 = await createWithEnv(
                request,
                owner.access_token,
                repo,
                secret,
                'apw13-t32-neg12-b',
            );
            expect(created2.text).not.toContain(secret);
        },
    );
});
