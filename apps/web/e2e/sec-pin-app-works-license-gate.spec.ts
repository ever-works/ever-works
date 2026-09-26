/**
 * APW-13 T32 — SEC PIN: the App Works licence gate (ACC-NEG-01, ACC-NEG-02).
 *
 * ## What the acceptance cases ask for, in their own words
 *
 * **ACC-NEG-01 — Licence red** (`ACCEPTANCE.md:706`):
 *
 * > Inspect shows class `red` with the licence name; **Ever Works Apps** shown
 * > unavailable with its licence reason text; the Apps catalog never lists it
 * > (`GET /api/apps-catalog`); choosing the managed target is refused with a
 * > stable licence code even when the UI is bypassed. **Your cluster:** the deploy
 * > is refused ("{name} needs the license terms confirmed before it can run on
 * > your cluster.") until the **Work owner** attests
 * > (`POST /api/works/:id/app-license/attest` → `200`, `app.license.attested`),
 * > then accepted (APW-03 FR-57, APW-06 FR-9, R-3).
 *
 * **ACC-NEG-02 — Licence amber** (`ACCEPTANCE.md:707`):
 *
 * > `app.license.classified` records class `amber` (+ `app.license.attestation_required`);
 * > a Your-cluster deploy is refused until the **Work owner** ticks the statement
 * > and presses **Confirm** (`POST /api/works/:id/app-license/attest` → `200`); a
 * > manager gets `403`; `app.license.attested` records the attesting user and date.
 * > An upstream sync that relicenses green → amber emits `app.license.changed`
 * > (+ `app.license.attestation_required`), leaves the running Deployment serving,
 * > refuses the next Your-cluster Deployment until the owner re-attests, and Ever
 * > Works Apps stays refused (APW-03 FR-60, S16; ACC-03-35).
 *
 * ## What this file proves today, and what it cannot
 *
 * The PR lane's fake carries the whole fixture this pair of cases needs — its
 * checked-in seed (`fakes/github-fake/fixtures/catalog-pr-lane.seed.json`)
 * classifies `MIT`/`AGPL-3.0` **green**, `BUSL-1.1` **amber** and `NOASSERTION`
 * **red**, and seeds `apw-e2e-upstream/amber-app` / `apw-e2e-upstream/red-app` for
 * exactly those two licences. What the lane cannot reach is the **gate**. Since
 * APW-03 T26 the inspector's catalog port IS bound (`AppWorksModule` binds
 * `AppSourceCatalogAdapter`), but its Blueprint resolver reads the `ever-works`
 * Blueprint repositories with a **platform** GitHub credential, and this lane has
 * none: no GitHub App installation on `ever-works` in the lane database and no
 * `EVER_WORKS_APPS_CATALOG_TOKEN` / `GITHUB_TOKEN` in `.github/workflows/e2e.yml`'s
 * env. The adapter therefore answers "credential unavailable", which the inspector
 * reads as `blueprint: unavailable` and `license: { class: 'unknown', source:
 * 'detected' }` — the classification (FR-57's `red`/`amber`, and the
 * `attestationRequired` flag the amber case hangs on) is *not produced here*,
 * `GET /api/apps-catalog` is **not mounted**, and
 * `POST /api/works/:id/app-license/attest` is **not mounted** either. A repository
 * the fixture's own catalog calls **red** is therefore accepted as an App Work with
 * no attestation, no refusal and no catalogue entry.
 *
 * ⚠ If the lane ever gains a catalog credential (any of the three above), the
 * running pins below flip on purpose: amber `BUSL-1.1` ⇒ class `amber`, green
 * `MIT` ⇒ `green`, `NOASSERTION` ⇒ `red`, and the Blueprint preview ⇒ `none` for a
 * repository no Blueprint names. Update them then — that is the gate starting to
 * work, not a regression.
 *
 * **NOASSERTION (owner decision, 2026-09-25):** GitHub's "a licence file I cannot
 * name" is carried through the inspector as `spdx: "NOASSERTION"` (it used to read
 * `null`, the same as "no licence file") and the platform classifier answers `red`
 * for it — the fixture's own classification.
 *
 * So the file is split, deliberately and visibly:
 *
 *   1. **Running, measured pins** (below) — the licence the provider declares *is*
 *      read on inspect; the *class* is `unknown` for a repository the fixture
 *      calls amber and for one it calls red; a red-licence repository is still
 *      created (`200`); the two routes the gate needs answer `404`. These pin the
 *      **absence** of the control, so the day APW-03 lands them they fail loudly
 *      rather than passing for the wrong reason.
 *   2. **`test.fixme('APW-03: …')`** — the two acceptance cases themselves, whose
 *      assertions need the classification, the events, the deploy refusal and the
 *      attestation write. The measured reason is in each marker.
 *
 * ## Measured on this lane (2026-09-19)
 *
 * API `node apps/api/dist/main.js` on **3998** (sqlite in memory, the runbook's
 * env — see the lane notes at the bottom of this file), fake GitHub on **3902**,
 * accounts attached through `connectCustomerGitHub`:
 *
 *   - inspect `https://github.com/apw-e2e-upstream/amber-app` → `200`
 *     `license: {"spdx":"BUSL-1.1","class":"unknown","source":"detected"}`
 *   - inspect `https://github.com/apw-e2e-upstream/red-app` → `200`
 *     `license: {"spdx":null,"class":"unknown","source":"detected"}` — from
 *     2026-09-25 the `spdx` reads `"NOASSERTION"` instead (the owner decision above;
 *     expected from the code change, not re-measured on the lane)
 *   - `POST /api/works` (`kind: app`, `repositoryMode: fork`) from a fresh
 *     NOASSERTION repository → `200` with `work.kind === "app"`
 *   - `GET /api/apps-catalog` → `404 {"message":"Cannot GET /api/apps-catalog"}`
 *   - `POST /api/works/:id/app-license/attest` → `404 {"message":"Cannot POST …"}`
 *
 * The assertions below are the ones that are true **today**; the deviations from
 * the acceptance case's words are reported as findings beside this file and are
 * never asserted as if they were the contract.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext } from '@playwright/test';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    attestAppLicense,
    createAppWork,
    deployAppWork,
    getUpstream,
    inspectAppSource,
    listAppsCatalog,
    rawApi,
    syncUpstream,
} from './helpers/app-works';
import { registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/**
 * Serial, for the reason T30's spec documents: `playwright.config.ts` sets
 * `fullyParallel: true`, so a local run beside the sibling lanes puts every case
 * of every file on one API and one in-memory SQLite at once. Measured on this box
 * (2026-09-19): a create that answers in ~5 s idle took ~33 s with eight workers.
 * Serialising keeps every assertion measuring the platform rather than the host;
 * in CI the shard already runs one worker, where this is a no-op. No assertion is
 * weakened by it.
 */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`) — where "no write" is readable. */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives the run account. */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot push to — so every create here is a fork. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/** The fixture's amber/red repositories, as the seed names them. */
const FIXTURE_AMBER_REPO = 'amber-app';
const FIXTURE_RED_REPO = 'red-app';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** `https://github.com/<owner>/<repo>` — what the form pastes. */
function repoUrl(repo: { owner: string; name: string }): string {
    return `https://github.com/${repo.owner}/${repo.name}`;
}

// ---------------------------------------------------------------------------
// The fake GitHub's control API
// ---------------------------------------------------------------------------

interface FakeCall {
    method?: string;
    path?: string;
    tokenIdentity?: string;
    status?: number | null;
}

/** Every call the fake has served, or `null` when it is not reachable. */
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

/**
 * The fake's PR-lane catalog, as checked in (plan §8.3, T2). Located from the
 * working directory, because a spec may be launched from `apps/web` (the lane) or
 * from the repo root (a direct invocation).
 */
function fakeSeedFixturePath(): string | null {
    for (const candidate of [
        'e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
        'apps/web/e2e/fakes/github-fake/fixtures/catalog-pr-lane.seed.json',
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * The licence classes the **fixture's own catalog** declares, `spdx → class`.
 *
 * Read from the checked-in file rather than hand-copied, so this spec cannot drift
 * from the fixture the lane seeds: if the fixture stops calling BUSL-1.1 amber,
 * the assertion that says so fails here first.
 */
function fixtureLicenseClasses(): Map<string, string> {
    const classes = new Map<string, string>();
    const fixture = fakeSeedFixturePath();
    if (fixture === null) return classes;
    try {
        const seed = JSON.parse(readFileSync(fixture, 'utf8')) as {
            catalog?: { licenses?: Array<{ spdx?: string; class?: string }> };
        };
        for (const row of seed.catalog?.licenses ?? []) {
            if (typeof row.spdx === 'string' && typeof row.class === 'string') {
                classes.set(row.spdx, row.class);
            }
        }
    } catch {
        return classes;
    }
    return classes;
}

/**
 * Put the checked-in fixture into the fake's state and add this test's own
 * repositories. `POST /_control/seed` upserts, so a re-run or a spec running
 * beside this one is harmless. Returns `false` when the fake is unreachable, which
 * each caller turns into a named `test.skip`.
 */
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

/**
 * The mutating methods a GitHub **write** can arrive with. `POST /graphql` is
 * deliberately not counted — the git plugin issues it as a read and the fake
 * serves no such route (it answers `404`), the same reason T30's spec gives.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isGitHubWrite(call: FakeCall): boolean {
    const method = (call.method ?? '').toUpperCase();
    const path = call.path ?? '';
    if (!MUTATING_METHODS.has(method)) return false;
    return !path.startsWith('/graphql');
}

/** The mutating calls whose path names one repository. */
function writesMatching(calls: FakeCall[], needle: string): FakeCall[] {
    return calls.filter((call) => isGitHubWrite(call) && (call.path ?? '').includes(needle));
}

/**
 * `owner/name` as the fake's call log spells it: **with its `/repos` prefix**
 * (measured in the ledger — `POST /repos/apw-e2e-upstream/<repo>/forks`). The
 * `writesMatching` filter above uses the bare `owner/name` substring, so it is
 * indifferent to the prefix; this helper is for the exact-path assertions.
 */
function fakePath(owner: string, name: string): string {
    return `/repos/${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// The shapes this file reads back
// ---------------------------------------------------------------------------

interface InspectView {
    repository?: { fullName?: string; visibility?: string };
    modes?: {
        link?: { available?: boolean; reason?: string };
        fork?: { available?: boolean; reason?: string };
        'private-copy'?: { available?: boolean; reason?: string };
    };
    defaultMode?: string | null;
    blueprint?: { status?: string; id?: string };
    license?: { spdx?: string | null; class?: string; source?: string };
    /** The flag ACC-NEG-02's amber half hangs on — absent from the body today. */
    attestationRequired?: boolean;
}

interface CreatedView {
    work?: { id?: string; kind?: string; slug?: string };
    appSource?: { relation?: string };
}

/** Inspect one URL and hand back the status, the typed body and the raw text. */
async function inspect(
    request: APIRequestContext,
    token: string,
    repositoryUrl: string,
): Promise<{ status: number; body: InspectView; text: string }> {
    const result = await inspectAppSource(request, {
        token,
        body: appSourceInspectBody({ repositoryUrl }),
    });
    return { status: result.status, body: (result.json ?? {}) as InspectView, text: result.text };
}

/** Create a forked App Work from one repository and hand back the answer. */
async function createFork(
    request: APIRequestContext,
    token: string,
    repo: { owner: string; name: string },
    slugBase: string,
): Promise<{ status: number; body: CreatedView; text: string }> {
    const slug = `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const result = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T32 NEG-01/02 ${slugBase}`,
            organization: false,
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
        }),
    });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

// ---------------------------------------------------------------------------
// Running pins — the state of the gate as measured today
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-01/02 — the licence class the gate turns on is not produced', () => {
    test('the fixture classifies BUSL-1.1 amber and NOASSERTION red, and every inspect still answers class "unknown"', async ({
        request,
    }) => {
        test.skip(
            !(await seedFakeGitHub(request)),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is ` +
                'nothing to inspect in this run (the PR lane starts it beside the API).',
        );

        const classes = fixtureLicenseClasses();
        expect(
            classes.get('MIT'),
            'the checked-in fixture classifies MIT green — read from the file, not copied',
        ).toBe('green');
        expect(classes.get('BUSL-1.1'), 'and BUSL-1.1 amber').toBe('amber');
        expect(classes.get('NOASSERTION'), 'and NOASSERTION red').toBe('red');

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // The amber repository the fixture seeds for ACC-NEG-02.
        const amber = await inspect(
            request,
            user.access_token,
            repoUrl({ owner: UPSTREAM_OWNER, name: FIXTURE_AMBER_REPO }),
        );
        expect(amber.status, `inspect amber body=${amber.text.slice(0, 300)}`).toBe(200);
        expect(
            amber.body.license?.spdx,
            'the licence NAME ACC-NEG-01 asks the panel to show is read from the provider',
        ).toBe('BUSL-1.1');
        expect(
            amber.body.license?.class,
            'the fixture calls BUSL-1.1 amber and the inspector answers "unknown" for it: the ' +
                'catalog port is bound (APW-03 T26) but this lane gives the platform no GitHub ' +
                'credential for the ever-works catalog, so the catalog cannot be consulted. With ' +
                'a catalog credential this becomes "amber" — update the pin then',
        ).toBe('unknown');
        expect(amber.body.license?.source, 'nothing is persisted before a create').toBe('detected');
        expect(
            'attestationRequired' in amber.body,
            'the `attestationRequired` flag ACC-NEG-02 hangs on is not a field of the answer yet',
        ).toBe(false);
        expect(
            amber.body.blueprint?.status,
            'the same missing platform credential is why the Blueprint match is "unavailable", ' +
                'never "none" (with one, a repository no Blueprint names previews "none")',
        ).toBe('unavailable');

        // The red repository the fixture seeds for ACC-NEG-01.
        const red = await inspect(
            request,
            user.access_token,
            repoUrl({ owner: UPSTREAM_OWNER, name: FIXTURE_RED_REPO }),
        );
        expect(red.status, `inspect red body=${red.text.slice(0, 300)}`).toBe(200);
        // Pinned `null` until 2026-09-25, when a NOASSERTION licence read the same as "no
        // licence file". The owner decision carries it through as its own value, which the
        // platform classifier answers red for (the fixture's own class).
        expect(
            red.body.license?.spdx,
            'a NOASSERTION licence is carried through as "NOASSERTION" — the SPDX half is read',
        ).toBe('NOASSERTION');
        expect(
            red.body.license?.class,
            'the class is not: no platform catalog credential in this lane (with one, "red")',
        ).toBe('unknown');

        // The green control: the same read, on a repository the fixture calls green.
        const green = await inspect(
            request,
            user.access_token,
            'https://github.com/ever-works/umami-template',
        );
        expect(green.status, `body=${green.text.slice(0, 300)}`).toBe(200);
        expect(green.body.license?.spdx).toBe('MIT');
        expect(
            green.body.license?.class,
            'green is not classified either, for the same missing credential (with one, "green")',
        ).toBe('unknown');
    });

    test('a RED-licence repository is created as an App Work today: no refusal, no attestation route, no catalog entry', async ({
        request,
    }) => {
        const run = stamp();
        const redRepo = { owner: UPSTREAM_OWNER, name: `apw13-t32-red-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [
                {
                    ...redRepo,
                    license: { key: 'other', name: 'NOASSERTION', spdx_id: 'NOASSERTION' },
                },
            ])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the red ` +
                'repository cannot be set up in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        // 1. The create is ACCEPTED — the fact ACC-NEG-01's "refused until the Work owner
        //    attests" is the opposite of.
        const created = await createFork(request, user.access_token, redRepo, 'apw13-t32-red');
        expect(created.status, `a red-licence fork create body=${created.text.slice(0, 300)}`).toBe(
            200,
        );
        const workId = created.body.work?.id ?? '';
        expect(workId, 'an App Work exists for the red-licence repository').toBeTruthy();
        expect(created.body.work?.kind).toBe('app');
        expect(
            /license|licence/i.test(created.text),
            'and the create answer carries no licence field at all',
        ).toBe(false);

        // 2. The create really wrote to GitHub — the positive control that makes the
        //    "no PR/no extra write" assertions elsewhere in this family meaningful.
        const calls = (await fakeGitHubCalls(request)) ?? [];
        const forkWrites = writesMatching(calls, fakePath(redRepo.owner, redRepo.name));
        expect(
            forkWrites.length,
            `the fork the create was asked for is the one write against the repository ` +
                `(writes=${JSON.stringify(forkWrites.map((c) => `${c.method} ${c.path}`))})`,
        ).toBe(1);
        expect(forkWrites[0]?.method?.toUpperCase()).toBe('POST');
        expect(forkWrites[0]?.path).toBe(`${fakePath(redRepo.owner, redRepo.name)}/forks`);

        // 3. Neither route the gate needs is mounted: the catalog the case says must
        //    never list it, and the attestation the case says unblocks it.
        const catalog = await listAppsCatalog(request, {});
        expect(
            catalog.status,
            `GET /api/apps-catalog body=${catalog.text.slice(0, 200)} — the catalog route ` +
                'APW-03 owns is not mounted on this API, so "never lists it" cannot be observed ' +
                'as a property of the catalog; it is observed as the route being absent.',
        ).toBe(404);
        expect(catalog.text).toContain('Cannot GET /api/apps-catalog');

        const attest = await attestAppLicense(request, {
            token: user.access_token,
            workId,
            body: { accepted: true },
        });
        expect(
            attest.status,
            `POST /api/works/:id/app-license/attest body=${attest.text.slice(0, 200)} — the write ` +
                'ACC-NEG-01/02 use to unblock a deploy does not exist yet (APW-03)',
        ).toBe(404);
        expect(attest.text).toContain('Cannot POST');
    });
});

// ---------------------------------------------------------------------------
// The two acceptance cases, blocked by APW-03
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-01/02 — the gate itself (fixme until APW-03)', () => {
    /**
     * ACC-NEG-01. Blocked on APW-03, measured on this lane: the inspector answers
     * `license.class: "unknown"` for the fixture's `red-app` (measured above) —
     * since APW-03 T26 the catalog port is bound and the platform classifies
     * NOASSERTION red, but this lane gives the platform no GitHub credential for the
     * ever-works catalog, so the catalog is never consulted — and
     * `GET /api/apps-catalog` answers `404 Cannot GET`, and
     * `POST /api/works/:id/app-license/attest` answers `404 Cannot POST`: there is
     * no classification to refuse on here, no catalog to be absent from, and no
     * attestation to write. APW-06 owns the deploy-side refusal the case also names.
     */
    test.fixme(
        'APW-03: the red-licence refusals need a platform catalog credential in this lane ' +
            '(the catalog port is bound since T26, but without one inspect answers class ' +
            '"unknown") and the attestation route — /api/apps-catalog and ' +
            '/api/works/:id/app-license/attest answer 404 (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const redRepo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg01-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [
                    {
                        ...redRepo,
                        license: { key: 'other', name: 'NOASSERTION', spdx_id: 'NOASSERTION' },
                    },
                ])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const user = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, user.access_token);

            // "Inspect shows class `red` with the licence name".
            const inspected = await inspect(request, user.access_token, repoUrl(redRepo));
            expect(inspected.status).toBe(200);
            expect(inspected.body.license?.class).toBe('red');

            const created = await createFork(
                request,
                user.access_token,
                redRepo,
                'apw13-t32-neg01',
            );
            expect(created.status, 'a red App Work still exists — the gate is on the deploy').toBe(
                200,
            );
            const workId = created.body.work?.id ?? '';

            // "Ever Works Apps shown unavailable with its licence reason text".
            const targets = await inspect(request, user.access_token, repoUrl(redRepo));
            expect(
                (targets.body as { deployTargets?: Record<string, unknown> }).deployTargets,
            ).toMatchObject({ 'ever-works-apps': { available: false, reason: 'license_red' } });

            // "The Apps catalog never lists it".
            const catalog = await listAppsCatalog(request, {});
            expect(catalog.status).toBe(200);
            expect(catalog.text).not.toContain(redRepo.name);
            expect(catalog.text).not.toContain(workId);

            // "Choosing the managed target is refused with a stable licence code even
            //  when the UI is bypassed" — the PUT the UI would make, with the UI skipped.
            const managed = await createAppWork(request, {
                token: user.access_token,
                body: appWorkCreateBody({
                    name: `apw13-t32-neg01-managed-${run}`,
                    slug: `apw13-t32-neg01-managed-${run}`.toLowerCase(),
                    organization: false,
                    repositoryUrl: repoUrl(redRepo),
                    repositoryMode: 'fork',
                    targetOwner: LANE_LOGIN,
                    deployProvider: 'ever-works',
                }),
            });
            expect(managed.status).toBe(400);
            expect(managed.text).toContain('license_red');

            // "Your cluster: the deploy is refused … until the Work owner attests".
            const before = await fetchDeploy(request, user.access_token, workId);
            expect(before.status).toBe(422);
            expect(before.text).toContain(
                'needs the license terms confirmed before it can run on your cluster',
            );

            const attest = await attestAppLicense(request, {
                token: user.access_token,
                workId,
                body: { accepted: true },
            });
            expect(attest.status, 'the Work owner attests').toBe(200);
            expect(attest.text).toContain('app.license.attested');

            const after = await fetchDeploy(request, user.access_token, workId);
            expect(after.status, 'then the deploy is accepted').toBe(200);
        },
    );

    /**
     * ACC-NEG-02. The same blockers, plus the two facts this lane cannot stage at
     * all: a **manager** of the Work (an organization role the fixture does not
     * have) and an **upstream sync that relicenses green → amber** (APW-02's sync
     * runs in the nightly lane). The measured blocker is APW-03's: no
     * `app.license.classified` / `app.license.changed` event exists, because
     * nothing classifies a licence.
     */
    test.fixme(
        'APW-03: the amber flow needs classification and its events (app.license.classified, ' +
            'app.license.attestation_required, app.license.changed) — no licence is classified on ' +
            'this lane and the attestation route is not mounted (measured 2026-09-19)',
        async ({ request }: { request: APIRequestContext }) => {
            const run = stamp();
            const amberRepo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg02-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [
                    {
                        ...amberRepo,
                        license: {
                            key: 'bsl-1.1',
                            name: 'Business Source License 1.1',
                            spdx_id: 'BUSL-1.1',
                        },
                    },
                ])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const owner = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, owner.access_token);

            const created = await createFork(
                request,
                owner.access_token,
                amberRepo,
                'apw13-t32-neg02',
            );
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';

            // `app.license.classified` records class `amber` (+ attestation required).
            const activity = await readActivity(request, owner.access_token);
            expect(activity.text).toContain('app.license.classified');
            expect(activity.text).toContain('app.license.attestation_required');

            // A Your-cluster deploy is refused until the Work owner confirms.
            const refused = await fetchDeploy(request, owner.access_token, workId);
            expect(refused.status).toBe(422);
            expect(refused.text).toContain('license terms');

            // The owner attests; a manager does not get to.
            const manager = await registerUserViaAPI(request);
            const asManager = await attestAppLicense(request, {
                token: manager.access_token,
                workId,
                body: { accepted: true },
            });
            expect(asManager.status, 'a manager is refused').toBe(403);

            const asOwner = await attestAppLicense(request, {
                token: owner.access_token,
                workId,
                body: { accepted: true },
            });
            expect(asOwner.status).toBe(200);
            expect(asOwner.text).toContain('app.license.attested');
            expect(asOwner.text, 'the attestation records the attesting user and date').toMatch(
                /"attestedAt"/,
            );

            // An upstream sync that relicenses green → amber: the running Deployment keeps
            // serving, the next Your-cluster Deployment is refused, Ever Works Apps stays
            // refused (APW-02's sync + APW-06's preconditions).
            const sync = await syncUpstreamFor(request, owner.access_token, workId);
            expect(sync.status).toBe(202);
            const reAttest = await fetchDeploy(request, owner.access_token, workId);
            expect(reAttest.status, 'the next deploy is refused until the owner re-attests').toBe(
                422,
            );
        },
    );
});

// ---------------------------------------------------------------------------
// The three wrappers the fixme bodies use
// ---------------------------------------------------------------------------

/**
 * `POST /api/deploy/works/:id` — the deploy call ACC-NEG-01/02 assert the refusal
 * of, reached through the App Works helper table's own wrapper.
 */
async function fetchDeploy(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; text: string }> {
    const result = await deployAppWork(request, { token, workId, body: {} });
    return { status: result.status, text: result.text };
}

/** `GET /api/activity-log` — where the licence events ACC-NEG-02 names would appear. */
async function readActivity(
    request: APIRequestContext,
    token: string,
): Promise<{ status: number; text: string }> {
    const result = await rawApi(request, 'GET', '/api/activity-log', {
        token,
        query: { limit: 50 },
    });
    return { status: result.status, text: result.text };
}

/**
 * `POST /api/works/:id/upstream/sync` — the APW-02 route the relicense case drives.
 * `getUpstream` is read first so the refusal the case is about is reached with the
 * Work's own state visible in the failure message rather than as a bare status.
 */
async function syncUpstreamFor(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ status: number; text: string }> {
    const before = await getUpstream(request, { token, workId });
    const result = await syncUpstream(request, { token, workId });
    return {
        status: result.status,
        text: `${result.text} (upstream read before the sync: ${before.status} ${before.text.slice(0, 120)})`,
    };
}
