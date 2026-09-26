/**
 * APW-13 T32 — SEC PIN: the Ever Works Apps managed-target gate (ACC-NEG-03).
 *
 * ## What the acceptance case asks for, in its own words
 *
 * **ACC-NEG-03 — Managed target without the gate** (`ACCEPTANCE.md:708`):
 *
 * > With `EVER_WORKS_APPS_MANAGED_ENABLED=false`, and again with it `true` while
 * > APW-10's tier is **Closed**: the option renders disabled with "Ever Works Apps
 * > is paused for new deployments. Apps already running are not affected.";
 * > `PUT /api/works/:id/app-target { target: 'ever-works-apps' }` → `422`
 * > `managed_disabled` and the target is unchanged; a deploy call for a managed
 * > target → `422` with the same precondition; no namespace appears on
 * > `<e2e-apps-tier>` (golden-path twin: a live-gated block in the same
 * > `sec-pin-app-works-managed-gate.spec.ts`, APW-13 T51).
 *
 * ## What this file proves today, and what it cannot
 *
 * The gate the case names has **one reader in the whole repository**:
 * `packages/contracts/src/apps/apps-tier.ts:1227` declares the constant
 * `APPS_TIER_MANAGED_ENABLED_ENV_VAR = 'EVER_WORKS_APPS_MANAGED_ENABLED'`, and no
 * guard, controller or service reads it (grep over `apps/api/src`,
 * `apps/web/src`, `packages/agent/src`, `packages/contracts/src`, 2026-09-19).
 * APW-10 is Wave 2 and unshipped, so `PUT /api/works/:id/app-target` — the route
 * that would answer `422 managed_disabled` — is **not mounted**, and the panel
 * half of the case has no surface in the PR lane at all.
 *
 * What *is* shipped, and what the running pins below measure, is APW-01's
 * create-side refusal: the managed target has an **input alias** (`'ever-works'`,
 * `packages/agent/src/app-works/app-work-create.service.ts:620`), and with the
 * tier policy port unbound the create refuses it **fail-closed** with
 * `managed_hosting_unavailable` (`:626-632`, R-5: "an unbound policy means
 * CLOSED"). The literal id the acceptance case writes — `'ever-works-apps'` — is
 * *not* the alias, so it is handled as a cluster target and refused with
 * `cluster_target_unavailable` instead. That difference is a finding, pinned
 * below rather than smoothed over.
 *
 * ## Measured on this lane (2026-09-19)
 *
 * API `node apps/api/dist/main.js` on **3998** (sqlite in memory; the runbook's
 * env, with `EVER_WORKS_APPS_MANAGED_ENABLED` **unset**, and — on the second run —
 * `EVER_WORKS_APP_LAUNCHER_ENABLED=true`), fake GitHub on **3902**:
 *
 *   - inspect → `deployTargets: {"none":{"available":true},
 *     "your-cluster":{"available":true,"providerId":"k8s"},
 *     "ever-works-apps":{"available":false,"reason":"managed_hosting_unavailable"}}`
 *   - `POST /api/works` with `deployProvider: 'ever-works'` → `400`
 *     `{"code":"managed_hosting_unavailable","message":"Ever Works Apps hosting is
 *     not open on this installation yet. …"}`
 *   - `POST /api/works` with `deployProvider: 'ever-works-apps'` → `400`
 *     `{"code":"cluster_target_unavailable", …}` — the literal id of the case is
 *     not the alias
 *   - `GET` and `PUT /api/works/:id/app-target` and `POST …/app-target/check` →
 *     `404` for the owner, for another account and for an anonymous caller alike
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
    appSourceInspectBody,
    appWorkCreateBody,
    checkAppTarget,
    createAppWork,
    getAppTarget,
    inspectAppSource,
    putAppTarget,
} from './helpers/app-works';
import { registerUserViaAPI } from './helpers/api';
import { connectCustomerGitHub } from './helpers/github-connection';

/** Serial for the reason T30's spec documents — see the header of the licence-gate pin. */
test.describe.configure({ mode: 'serial' });

/** The fake GitHub's control API (`plan §8.3`). */
const FAKE_GITHUB_URL = (process.env.APW_E2E_GITHUB_FAKE_URL ?? 'http://127.0.0.1:3900').replace(
    /\/+$/,
    '',
);

/** The login the checked-in PR-lane fixture gives the run account. */
const LANE_LOGIN = 'apw-e2e-user';

/** An owner the run account cannot push to — so every create here is a fork. */
const UPSTREAM_OWNER = 'apw-e2e-upstream';

/**
 * The managed target's **input alias** (APW-01 create step 4,
 * `app-work-create.service.ts:620`). Never persisted; the platform's own hosting
 * path is what it selects.
 */
const MANAGED_TARGET_ALIAS = 'ever-works';

/**
 * The id the acceptance case writes in the `PUT` body. Kept as its own constant
 * because the difference between it and {@link MANAGED_TARGET_ALIAS} is one of the
 * findings this file pins.
 */
const MANAGED_TARGET_CASE_ID = 'ever-works-apps';

/** The refusal copy the case quotes for the panel. */
const MANAGED_PAUSED_COPY =
    'Ever Works Apps is paused for new deployments. Apps already running are not affected.';

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

interface DeployTargetView {
    available?: boolean;
    reason?: string;
    providerId?: string;
}

interface InspectView {
    deployTargets?: Record<string, DeployTargetView>;
    modes?: { fork?: { available?: boolean; reason?: string } };
    defaultMode?: string | null;
}

interface CreatedView {
    work?: { id?: string; kind?: string; deployProvider?: string | null };
}

/** Create one forked App Work for `repo` with an explicit deploy target. */
async function createForkWithTarget(
    request: APIRequestContext,
    token: string,
    repo: { owner: string; name: string },
    deployProvider: string | undefined,
    slugBase: string,
): Promise<{ status: number; body: CreatedView; text: string }> {
    const slug = `${slugBase}-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const result = await createAppWork(request, {
        token,
        body: appWorkCreateBody({
            name: slug,
            slug,
            description: `APW-13 T32 NEG-03 ${slugBase}`,
            organization: false,
            repositoryUrl: repoUrl(repo),
            repositoryMode: 'fork',
            targetOwner: LANE_LOGIN,
            ...(deployProvider === undefined ? {} : { deployProvider }),
        }),
    });
    return { status: result.status, body: (result.json ?? {}) as CreatedView, text: result.text };
}

// ---------------------------------------------------------------------------
// Running pins — the managed target as this installation actually answers
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-03 — the managed target is refused fail-closed, with a code that is not the gate’s', () => {
    test('the inspect previews the three targets and refuses Ever Works Apps with a tier reason, never with the gate’s own code', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-managed-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the target ` +
                'preview cannot be read in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const inspected = await inspectAppSource(request, {
            token: user.access_token,
            body: appSourceInspectBody({ repositoryUrl: repoUrl(repo) }),
        });
        expect(inspected.status, `inspect body=${inspected.text.slice(0, 300)}`).toBe(200);
        const body = (inspected.json ?? {}) as InspectView;

        expect(body.deployTargets?.none, 'ACC-E2E-11/R-12: None is always offered').toMatchObject({
            available: true,
        });
        expect(
            body.deployTargets?.[MANAGED_TARGET_CASE_ID]?.available,
            'the managed target is NOT offered on this installation',
        ).toBe(false);
        expect(
            body.deployTargets?.[MANAGED_TARGET_CASE_ID]?.reason,
            'and it is refused by the tier’s own availability rule — not by ' +
                '`EVER_WORKS_APPS_MANAGED_ENABLED`, whose only reader in the repository is the ' +
                'constant packages/contracts/src/apps/apps-tier.ts:1227',
        ).toBe('managed_hosting_unavailable');
        expect(
            inspected.text.includes('managed_disabled'),
            'the code ACC-NEG-03 requires is not produced anywhere on this route',
        ).toBe(false);
    });

    test('creating an App Work for the managed target is refused 400 managed_hosting_unavailable when the alias is used', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-managed-alias-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the managed ` +
                'create cannot be attempted in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const created = await createForkWithTarget(
            request,
            user.access_token,
            repo,
            MANAGED_TARGET_ALIAS,
            'apw13-t32-managed-alias',
        );
        expect(
            created.status,
            `create with deployProvider=${MANAGED_TARGET_ALIAS} body=${created.text.slice(0, 300)}`,
        ).toBe(400);
        expect(
            created.text,
            'the managed target is refused fail-closed (R-5: an unbound tier policy means CLOSED)',
        ).toContain('"code":"managed_hosting_unavailable"');
        expect(created.text, 'with the copy that names the two alternatives').toContain(
            'Ever Works Apps hosting is not open on this installation yet',
        );
        expect(
            created.body.work,
            'and nothing is persisted — there is no Work to read back',
        ).toBeUndefined();

        // The refusal happened before any provider write: the fork the create would
        // otherwise have asked for is absent from the fake's log.
        const calls = (await fakeGitHubCalls(request)) ?? [];
        const writes = calls.filter(
            (call) =>
                ['POST', 'PUT', 'PATCH', 'DELETE'].includes((call.method ?? '').toUpperCase()) &&
                (call.path ?? '').includes(`/${repo.owner}/${repo.name}`),
        );
        expect(
            writes.length,
            `the refused create wrote nothing to GitHub (writes=${JSON.stringify(
                writes.map((c) => `${c.method} ${c.path}`),
            )})`,
        ).toBe(0);
    });

    test('the literal id ACC-NEG-03 writes ("ever-works-apps") is refused as a CLUSTER target — a different code for the same choice', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-managed-literal-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so the literal-id ` +
                'create cannot be attempted in this run.',
        );

        const user = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, user.access_token);

        const created = await createForkWithTarget(
            request,
            user.access_token,
            repo,
            MANAGED_TARGET_CASE_ID,
            'apw13-t32-managed-literal',
        );
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(400);
        expect(
            created.text,
            'the case’s literal id is not recognised as the managed target, so the refusal is the ' +
                'cluster one — the finding this pin exists to keep visible',
        ).toContain('"code":"cluster_target_unavailable"');
        expect(
            created.text.includes('managed_hosting_unavailable'),
            'no managed reason is produced for the id the case names',
        ).toBe(false);

        // The positive control: the alias, on its own repository, reaches the OTHER
        // branch — so the difference above is the alias rule, not an ordering accident.
        const aliasRepo = { owner: UPSTREAM_OWNER, name: `apw13-t32-managed-literal2-${run}` };
        expect(
            await seedFakeGitHub(request, [aliasRepo]),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
        ).toBe(true);
        const viaAlias = await createForkWithTarget(
            request,
            user.access_token,
            aliasRepo,
            MANAGED_TARGET_ALIAS,
            'apw13-t32-managed-literal2',
        );
        expect(viaAlias.status).toBe(400);
        expect(viaAlias.text).toContain('"code":"managed_hosting_unavailable"');
    });

    test('the three app-target routes the case drives are not mounted — 404 for the owner, for another account and for nobody', async ({
        request,
    }) => {
        const run = stamp();
        const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-managed-routes-${run}` };
        test.skip(
            !(await seedFakeGitHub(request, [repo])),
            `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed, so there is no ` +
                'App Work to point the routes at in this run.',
        );

        const owner = await registerUserViaAPI(request);
        await connectCustomerGitHub(request, owner.access_token);
        const other = await registerUserViaAPI(request);

        const created = await createForkWithTarget(
            request,
            owner.access_token,
            repo,
            undefined,
            'apw13-t32-managed-routes',
        );
        expect(created.status, `body=${created.text.slice(0, 300)}`).toBe(200);
        const workId = created.body.work?.id ?? '';
        expect(workId).toBeTruthy();

        const attempts: Array<{
            label: string;
            run: (token: string) => Promise<{ status: number; text: string }>;
        }> = [
            {
                label: 'GET app-target',
                run: (token) => getAppTarget(request, { token, workId }),
            },
            {
                label: 'PUT app-target',
                run: (token) =>
                    putAppTarget(request, {
                        token,
                        workId,
                        body: { target: MANAGED_TARGET_CASE_ID },
                    }),
            },
            {
                label: 'POST app-target/check',
                run: (token) => checkAppTarget(request, { token, workId, body: {} }),
            },
        ];

        for (const attempt of attempts) {
            const mine = await attempt.run(owner.access_token);
            expect(
                mine.status,
                `${attempt.label} (owner) body=${mine.text.slice(0, 200)} — APW-06 owns this route ` +
                    'and it does not exist on this API yet',
            ).toBe(404);
            expect(mine.text).toContain('Cannot');
            const theirs = await attempt.run(other.access_token);
            expect(
                theirs.status,
                `${attempt.label} (another account) body=${theirs.text.slice(0, 200)}`,
            ).toBe(404);
            const anon = await attempt.run('');
            expect(anon.status, `${attempt.label} (no session) is 404 as well`).toBe(404);
        }

        // The copy the case quotes for the panel exists nowhere this lane can reach —
        // asserted so that "the copy is missing" is measured rather than assumed.
        const putResult = await putAppTarget(request, {
            token: owner.access_token,
            workId,
            body: { target: MANAGED_TARGET_CASE_ID },
        });
        expect(
            putResult.text.includes(MANAGED_PAUSED_COPY),
            'the paused copy the case quotes is not served by any route this lane reaches',
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The acceptance case, blocked by APW-06 + APW-10
// ---------------------------------------------------------------------------

test.describe('ACC-NEG-03 — the managed gate itself (fixme until APW-06 + APW-10)', () => {
    /**
     * The measured blocker, in one line per missing piece:
     *
     *   - `PUT /api/works/:id/app-target` → `404 Cannot PUT` (measured), so neither
     *     the `422 managed_disabled` nor "the target is unchanged" can be produced;
     *   - `EVER_WORKS_APPS_MANAGED_ENABLED` is read by no code path (only the
     *     constant at `packages/contracts/src/apps/apps-tier.ts:1227`), so the
     *     case's *first* configuration — the variable `false` — changes nothing
     *     observable. The refusal measured today comes from the unbound tier policy
     *     instead (`app-work-create.service.ts:626-632`), which is APW-10's;
     *   - the panel half (the option rendering disabled with the quoted copy) is
     *     APW-06 T49's surface, and the live-gated twin belongs to APW-13 T51.
     */
    test.fixme(
        'APW-10: the managed gate has no route and no reader — PUT /api/works/:id/app-target ' +
            'answers 404 Cannot PUT, and EVER_WORKS_APPS_MANAGED_ENABLED is read only as a ' +
            'constant (measured 2026-09-19)',
        async ({ request, page }: { request: APIRequestContext; page: Page }) => {
            const run = stamp();
            const repo = { owner: UPSTREAM_OWNER, name: `apw13-t32-neg03-${run}` };
            test.skip(
                !(await seedFakeGitHub(request, [repo])),
                `the fake GitHub at ${FAKE_GITHUB_URL} is not answering /_control/seed.`,
            );
            const owner = await registerUserViaAPI(request);
            await connectCustomerGitHub(request, owner.access_token);

            const created = await createForkWithTarget(
                request,
                owner.access_token,
                repo,
                undefined,
                'apw13-t32-neg03',
            );
            expect(created.status).toBe(200);
            const workId = created.body.work?.id ?? '';

            // `/api/works/:id/app-target { target: 'ever-works-apps' }` → 422
            // `managed_disabled`, and the target is unchanged.
            const before = await getAppTarget(request, { token: owner.access_token, workId });
            expect(before.status).toBe(200);
            const refused = await putAppTarget(request, {
                token: owner.access_token,
                workId,
                body: { target: MANAGED_TARGET_CASE_ID },
            });
            expect(refused.status).toBe(422);
            expect(refused.text).toContain('"code":"managed_disabled"');
            const after = await getAppTarget(request, { token: owner.access_token, workId });
            expect(after.text).toBe(before.text);

            // A deploy call for a managed target → 422 with the same precondition.
            const deploy = await createAppWork(request, {
                token: owner.access_token,
                body: appWorkCreateBody({
                    name: `apw13-t32-neg03-deploy-${run}`,
                    slug: `apw13-t32-neg03-deploy-${run}`.toLowerCase(),
                    organization: false,
                    repositoryUrl: repoUrl(repo),
                    repositoryMode: 'fork',
                    targetOwner: LANE_LOGIN,
                    deployProvider: MANAGED_TARGET_ALIAS,
                }),
            });
            expect(deploy.status).toBe(422);
            expect(deploy.text).toContain('"code":"managed_disabled"');

            // The panel: the option renders disabled with the quoted copy. The
            // live-gated twin (APW-13 T51) asserts the same against a running stack;
            // asserted here so the copy's wording lives in one reviewable place.
            await page.goto(`/works/${workId}/deploy`);
            await expect(page.getByText(MANAGED_PAUSED_COPY)).toBeVisible();
        },
    );
});
