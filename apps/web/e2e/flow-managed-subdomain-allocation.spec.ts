/**
 * APW-13 T18 — Managed subdomain allocation and the per-user cap (ACC-REG-05).
 *
 * ACC-REG-05's recorded verdict is *Partial — no e2e allocation or cap of 3*,
 * with `flow-work-deploy-domains-chain.spec.ts` covering only the unallocated
 * read and the check order. This spec is the e2e half, split the way the task
 * (tasks.md:242-247) requires.
 *
 * ── The routes, read out of the controller (not the plan's summary):
 *
 *   • `GET  /api/deploy/works/:id/subdomain`  — `deploy.controller.ts:954`
 *   • `PUT  /api/deploy/works/:id/subdomain`  — `deploy.controller.ts:983`
 *
 * (The task text says `POST`; there is no POST — the re-allocation verb is
 * `PUT`, `UpdateSubdomainDto`. Both routes are driven here as they are.)
 * `PUT` runs its guards in a fixed order
 * (`apps/api/src/plugins-capabilities/deploy/managed-subdomain.service.ts:138-192`):
 * format → reserved label → work exists → editable → global uniqueness → DNS
 * provider. Only the last step needs DNS, which is why the refusal half is
 * runnable and the allocation half is not.
 *
 * ── The cap of three, and which cap it actually is:
 *
 * Two different caps exist in this tree, and only one is enforced:
 *
 *   • `config.everWorks.apps.getMaxPerUser()` → `EVER_WORKS_APPS_MAX_PER_USER`
 *     ("Managed tier App Works (paid)", CONTRACTS §7A:677, default 3) has NO
 *     non-spec caller — it belongs to APW-10/APW-06's managed tier, which is
 *     Wave 2 and unshipped, so it cannot be reached over HTTP today;
 *   • `config.everWorks.deploy.getMaxWorksPerUser()` →
 *     `EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER` (default 3) IS enforced, on create,
 *     by `EverWorksDeployQuotaService.assertWithinQuota`
 *     (`ever-works-deploy-quota.service.ts:36-58`, called from
 *     `work-lifecycle.service.ts:334-336`), counting active Works whose
 *     `deployProvider` is `ever-works`.
 *
 * This spec exercises the enforced one — the cap of 3 a user actually meets —
 * and records the unenforced one as a routed item rather than asserting it.
 * Reaching it needs `DEPLOY_EVER_WORKS_ENABLED=true` in the API's environment:
 * without that switch `resolveProviderDefaults` silently rewrites
 * `deployProvider: 'ever-works'` to `'vercel'` and the cap can never be reached.
 *
 * ── Where the two switch-dependent cases run (owner decision 2026-09-25):
 *
 * The cap case and the allocation-boundary case read the switch from the API
 * first (the onboarding catalog's `ever-works` deploy card is `available`
 * exactly when `config.everWorks.deploy.isEnabled()`, the reading
 * `resolveProviderDefaults` makes). On the 32-shard matrix the switch is off
 * on purpose — `flow-deploy-capability-contract.spec.ts` asserts the rewrite —
 * so there both cases are SKIPPED BY NAME. They run on the
 * `e2e-app-works-flags-on` job of `.github/workflows/e2e.yml`, which turns the
 * switch on and sets `APW_E2E_FLAGS_ON_LANE=1`; on that job a switch reading
 * off FAILS instead, so they can never pass vacuously. With the switch on,
 * every `deployProvider` assertion below stays a hard expect. The other cases
 * need no switch and run everywhere.
 *
 * ── Why the allocation half is fixme'd (and not faked):
 *
 * A successful `PUT` calls `EverWorksDnsService.getProvider()` and then the
 * provider's `ensureRecord` — i.e. a real Cloudflare API call against
 * `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID`. There is no switch that fakes
 * the DNS provider (plan §8.3's `EVER_WORKS_E2E_FAKES` covers the GITHUB plugin
 * only), so allocation carries
 * `test.fixme('APW-13 T18: needs a DNS provider fake')` and this spec instead
 * PROVES the boundary it stops at, on the live stack: with no DNS configured the
 * named 500 is returned and the Work is left with no subdomain — no half-applied
 * claim.
 *
 * Verified live against http://127.0.0.1:3100 (2026-09-18):
 *   - `GET` on a fresh Work → `200 {"subdomain":null,"fqdn":null,"url":null,
 *     "recordOk":false,"editable":false}`;
 *   - `PUT` invalid label → `400` (format), reserved `www` → `400` (blocklist),
 *     unknown Work → `404`, unauthenticated → `401`, stranger → `403`,
 *     valid label on a non-editable Work → `400`;
 *   - `PUT` a valid label on an `ever-works` Work → `500 "Managed DNS is not
 *     configured on this environment (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID
 *     / EVER_WORKS_DEPLOY_LB_HOSTNAME missing)."`, subdomain still `null`;
 *   - `DEPLOY_EVER_WORKS_ENABLED=true`: three `ever-works` creates succeed and
 *     the fourth is refused — 500 today, because
 *     `EverWorksDeployQuotaExceededError` is not mapped to an HTTP status.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const WORKS_URL = `${API_BASE}/api/works`;

/** The managed-subdomain routes as the controller declares them. */
const subdomainUrl = (workId: string): string => `${API_BASE}/api/deploy/works/${workId}/subdomain`;

/**
 * The enforced per-user cap. Read from the same variable the API reads so a lane
 * that raises it stays honest; the documented default is 3.
 */
const DEPLOY_CAP =
    Number.parseInt(process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER ?? '3', 10) || 3;

/**
 * `APW_E2E_FLAGS_ON_LANE=1` marks the one job that exists to run the
 * switch-dependent cases (`e2e-app-works-flags-on` in `.github/workflows/e2e.yml`).
 */
const FLAGS_ON_LANE = process.env.APW_E2E_FLAGS_ON_LANE === '1';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface WorkRow {
    id: string;
    slug?: string;
    kind?: string;
    deployProvider?: string | null;
    managedSubdomain?: string | null;
}

interface RawResult {
    status: number;
    text: string;
    json: Record<string, unknown> | null;
}

async function parse(res: {
    text: () => Promise<string>;
    status: () => number;
}): Promise<RawResult> {
    const text = await res.text();
    let json: RawResult['json'] = null;
    try {
        json = JSON.parse(text) as RawResult['json'];
    } catch {
        json = null;
    }
    return { status: res.status(), text, json };
}

/** Create a Work for `token`; never throws on a status. */
async function createWork(
    request: APIRequestContext,
    token: string,
    extra: Record<string, unknown> = {},
): Promise<{ result: RawResult; work: WorkRow | null }> {
    const result = await parse(
        await request.post(WORKS_URL, {
            headers: authedHeaders(token),
            data: {
                name: `apw13-t18 ${stamp()}`,
                slug: `apw13-t18-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                description: 'APW-13 T18 managed subdomain',
                organization: false,
                kind: 'website',
                ...extra,
            },
        }),
    );
    const work = (result.json?.work as WorkRow | undefined) ?? null;
    return { result, work };
}

/** Read one Work back through the works listing (never throws). */
async function listWorks(
    request: APIRequestContext,
    token: string,
): Promise<{ status: number; works: WorkRow[] }> {
    const res = await request.get(`${WORKS_URL}?limit=100`, { headers: authedHeaders(token) });
    const text = await res.text();
    let works: WorkRow[] = [];
    if (res.status() === 200) {
        const body = JSON.parse(text) as { works?: WorkRow[]; data?: WorkRow[] };
        works = body.works ?? body.data ?? [];
    }
    return { status: res.status(), works };
}

/**
 * Read `DEPLOY_EVER_WORKS_ENABLED` from the API — never from this process's env,
 * which need not match the API's — and skip the calling case by name when it
 * is off, unless this is the flags-on job, where off is a failure.
 *
 * The onboarding catalog's `ever-works` deploy card carries
 * `available: config.everWorks.deploy.isEnabled()`
 * (`apps/api/src/onboarding/onboarding-catalog.service.ts`), the same reading
 * `resolveProviderDefaults` makes before it rewrites `'ever-works'` to
 * `'vercel'`. Keyed on that reading alone, so a create that persists `'vercel'`
 * while the switch reads ON still fails the case's own hard expect.
 */
async function skipUnlessEverWorksDeployEnabled(
    request: APIRequestContext,
    token: string,
): Promise<void> {
    const res = await request.get(`${API_BASE}/api/onboarding/catalog`, {
        headers: authedHeaders(token),
    });
    const text = await res.text();
    expect(res.status(), `GET /api/onboarding/catalog body=${text.slice(0, 300)}`).toBe(200);
    const deploy = (
        JSON.parse(text) as { deploy?: Array<{ choice?: string; available?: unknown }> }
    ).deploy;
    const card = deploy?.find((entry) => entry.choice === 'ever-works');
    expect(
        typeof card?.available,
        'the onboarding catalog always carries the ever-works deploy card with a boolean ' +
            '`available` (onboarding-catalog.service.ts) — the switch reading this case keys on',
    ).toBe('boolean');
    const enabled = card?.available === true;
    if (FLAGS_ON_LANE) {
        expect(
            enabled,
            'STACK: this is the flags-on job (APW_E2E_FLAGS_ON_LANE=1), which exists to run this ' +
                'case, but the ever-works deploy card is unavailable — the API must run with ' +
                'DEPLOY_EVER_WORKS_ENABLED=true here.',
        ).toBe(true);
    }
    test.skip(
        !enabled,
        "DEPLOY_EVER_WORKS_ENABLED is off on this stack — 'ever-works' creates persist 'vercel' " +
            '(resolveProviderDefaults), so ACC-REG-05’s cap and allocation boundary are ' +
            'unreachable here; they run on the flags-on lane (e2e.yml job e2e-app-works-flags-on)',
    );
}

test.describe('Managed subdomain — the per-user cap', () => {
    test(`a user may hold ${DEPLOY_CAP} active ever-works deployments and the next create is refused`, async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await skipUnlessEverWorksDeployEnabled(request, user.access_token);

        const accepted: WorkRow[] = [];
        for (let index = 1; index <= DEPLOY_CAP; index += 1) {
            const { result, work } = await createWork(request, user.access_token, {
                deployProvider: 'ever-works',
            });
            expect(
                result.status,
                `create #${index} under the cap body=${result.text.slice(0, 300)}`,
            ).toBe(200);
            expect(
                work?.deployProvider,
                `create #${index} must persist deployProvider=ever-works — a 'vercel' value means ` +
                    'the lane is missing DEPLOY_EVER_WORKS_ENABLED=true, so the cap is unreachable ' +
                    '(work-lifecycle.service.ts resolveProviderDefaults) and this test would pass ' +
                    'vacuously',
            ).toBe('ever-works');
            if (work) accepted.push(work);
        }

        const refused = await createWork(request, user.access_token, {
            deployProvider: 'ever-works',
        });
        expect(
            refused.result.status,
            `the ${DEPLOY_CAP + 1}th ever-works create must be refused, body=${refused.result.text.slice(0, 300)}`,
        ).not.toBe(200);
        expect(refused.work, 'a refused create must not return a Work').toBeFalsy();

        const { status, works } = await listWorks(request, user.access_token);
        expect(status, 'the works listing is readable after the refusal').toBe(200);
        const everWorks = works.filter((work) => work.deployProvider === 'ever-works');
        expect(
            everWorks.map((work) => work.slug).sort(),
            `exactly ${DEPLOY_CAP} ever-works Works survive; the refusal deleted nothing and added nothing`,
        ).toEqual(accepted.map((work) => work.slug).sort());
    });
});

test.describe('Managed subdomain — allocation read and refusals', () => {
    test('an unallocated Work reads back a null subdomain with its editability, and never a partial claim', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { work } = await createWork(request, user.access_token);
        const workId = (work as WorkRow).id;

        const read = await parse(
            await request.get(subdomainUrl(workId), { headers: authedHeaders(user.access_token) }),
        );
        expect(read.status, `read body=${read.text.slice(0, 300)}`).toBe(200);
        expect(read.json?.status).toBe('success');
        expect(read.json?.subdomain, 'nothing allocated yet').toBeNull();
        expect(read.json?.fqdn).toBeNull();
        expect(read.json?.url).toBeNull();
        expect(read.json?.recordOk, 'no record exists for an unallocated Work').toBe(false);
        expect(
            read.json?.editable,
            'a vercel Work is not editable — the rename affordance is hidden for it',
        ).toBe(false);
    });

    test('PUT refusals: format, reserved label, unknown Work, unauthenticated, stranger, non-editable', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const { work } = await createWork(request, owner.access_token);
        const workId = (work as WorkRow).id;

        const invalidFormat = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(owner.access_token),
                data: { subdomain: 'Not A Label!' },
            }),
        );
        expect(invalidFormat.status, `format body=${invalidFormat.text.slice(0, 300)}`).toBe(400);
        expect(invalidFormat.text).toContain('Invalid subdomain format');

        const reserved = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(owner.access_token),
                data: { subdomain: 'www' },
            }),
        );
        expect(reserved.status, `reserved body=${reserved.text.slice(0, 300)}`).toBe(400);
        expect(reserved.text).toContain('is reserved by the platform');

        const unknownWork = await parse(
            await request.put(subdomainUrl(randomUUID()), {
                headers: authedHeaders(owner.access_token),
                data: { subdomain: `apw13-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '') },
            }),
        );
        expect(unknownWork.status, `unknown work body=${unknownWork.text.slice(0, 300)}`).toBe(404);

        const anonymous = await request.put(subdomainUrl(workId), {
            data: { subdomain: 'apw13-anon' },
        });
        expect(anonymous.status(), 'the route is authenticated').toBe(401);

        const stranger = await registerUserViaAPI(request);
        const strangerPut = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(stranger.access_token),
                data: { subdomain: 'apw13-stranger' },
            }),
        );
        expect([403, 404], `a stranger body=${strangerPut.text.slice(0, 300)}`).toContain(
            strangerPut.status,
        );

        const notEditable = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(owner.access_token),
                data: { subdomain: `apw13-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '') },
            }),
        );
        // A plain (vercel) Work is refused here; on an ever-works Work the same
        // request reaches the DNS provider instead, which is the test below.
        expect(notEditable.status, `non-editable body=${notEditable.text.slice(0, 300)}`).toBe(400);
        expect(notEditable.text).toContain('not editable for this work');
    });
});

test.describe('Managed subdomain — the allocation boundary the fake would have to cross', () => {
    test('a valid allocation on an ever-works Work stops at the missing DNS provider, leaving no half-applied claim', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        await skipUnlessEverWorksDeployEnabled(request, user.access_token);
        const { result, work } = await createWork(request, user.access_token, {
            deployProvider: 'ever-works',
        });
        expect(
            work?.deployProvider,
            `create body=${result.text.slice(0, 300)} — the lane needs ` +
                'DEPLOY_EVER_WORKS_ENABLED=true for an editable Work',
        ).toBe('ever-works');
        const workId = (work as WorkRow).id;

        const readBefore = await parse(
            await request.get(subdomainUrl(workId), { headers: authedHeaders(user.access_token) }),
        );
        expect(readBefore.json?.editable, 'an ever-works Work offers allocation').toBe(true);

        const allocated = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(user.access_token),
                data: { subdomain: `apw13-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '') },
            }),
        );
        expect(allocated.status, `allocation body=${allocated.text.slice(0, 400)}`).toBe(500);
        expect(
            allocated.text,
            'the refusal names the DNS configuration the allocation needs — this is the exact ' +
                'seam a DNS-provider fake has to fill (T18 fixme)',
        ).toContain('Managed DNS is not configured on this environment');

        const readAfter = await parse(
            await request.get(subdomainUrl(workId), { headers: authedHeaders(user.access_token) }),
        );
        expect(
            readAfter.json?.subdomain,
            'the failed allocation rolled back: the Work still holds no subdomain',
        ).toBeNull();
    });
});

test.describe('Managed subdomain — allocation itself (T18)', () => {
    // Allocation assigns the label, persists `work.managedSubdomain` and creates
    // the CNAME through the configured DNS provider. Faking that provider needs
    // a switch this epic does not have (plan §8.3's `EVER_WORKS_E2E_FAKES` is
    // GitHub-only), and pointing the real provider at Cloudflare from a PR lane
    // is not acceptable — so the half carries the named fixme until the fake
    // exists, and the test above pins exactly where it stops today.
    test.fixme('APW-13 T18: needs a DNS provider fake', async ({
        request,
    }: {
        request: APIRequestContext;
    }) => {
        const user = await registerUserViaAPI(request);
        const { work } = await createWork(request, user.access_token, {
            deployProvider: 'ever-works',
        });
        const workId = (work as WorkRow).id;
        const label = `apw13-${stamp()}`.toLowerCase().replace(/[^a-z0-9-]/g, '');

        const allocated = await parse(
            await request.put(subdomainUrl(workId), {
                headers: authedHeaders(user.access_token),
                data: { subdomain: label },
            }),
        );
        expect(allocated.status, `allocation body=${allocated.text.slice(0, 300)}`).toBe(200);
        expect(allocated.json?.subdomain, 'the label is persisted on the Work').toBe(label);
        expect(allocated.json?.fqdn, 'the FQDN is derived from the managed apex').toBe(
            `${label}.ever.works`,
        );
        expect(allocated.json?.recordOk, 'the fake DNS provider holds the record').toBe(true);

        // And the allocation is globally unique: a second Work claiming the
        // same label is refused with 409 (`findByManagedSubdomain`).
        const second = await createWork(request, user.access_token, {
            deployProvider: 'ever-works',
        });
        const conflict = await parse(
            await request.put(subdomainUrl((second.work as WorkRow).id), {
                headers: authedHeaders(user.access_token),
                data: { subdomain: label },
            }),
        );
        expect(conflict.status, `duplicate label body=${conflict.text.slice(0, 300)}`).toBe(409);
    });
});
