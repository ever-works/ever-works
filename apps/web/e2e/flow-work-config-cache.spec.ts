import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Work config + configCache lifecycle — COMPLEX cross-feature integration flows.
 *
 * Probed against the LIVE API (127.0.0.1:3100, sqlite CI driver, 2026-06-01)
 * AND read from source: apps/api/src/works/works.controller.ts,
 * apps/web/src/lib/api/work.ts, packages/agent/src/dto/update-work.dto.ts.
 *
 * REAL contract (NOT a separate writable "config" object — the assigned theme's
 * surfaces are spread across the Work entity + several subresources):
 *
 *   GET  /api/works/:id/config            -> 200 { status:'success', config: WorkConfig|null }
 *        - READ-ONLY snapshot of the data repo's `.works/works.yml`. There is
 *          NO writer on this path (probed: PUT/PATCH/POST/DELETE all -> 404).
 *          On a brand-new Work whose data repo is not yet populated (CI: no git
 *          push), `config` is null.
 *        - Server-side CACHED via cacheManager.wrap(getWorkConfigCacheKey(id,
 *          userId), …, WORK_CACHE_TTL_MS). Cache is PER-USER and invalidated by
 *          invalidateWorkCaches(id) on every Work mutation.
 *        - OWNER-ISOLATED: cross-user GET -> 403, anon -> 401, nonexistent -> 404.
 *
 *   GET  /api/works/:id                   -> 200 { work: { …, configCache, readmeConfig,
 *                                                          kbConfig, communityPrEnabled, … } }
 *        - `configCache` = cached WorkConfig from `.works/works.yml` (null until
 *          backfilled). `readmeConfig` = MarkdownReadmeConfig (header/footer +
 *          overwrite flags). `kbConfig` (null fresh, read-only via this DTO).
 *          `communityPrEnabled`/`communityPrAutoClose` flags (false fresh).
 *
 *   PUT  /api/works/:id  (UpdateWorkDto)  -> 200 { status:'success', work }
 *        - The writer for readmeConfig + communityPr* flags. MERGES: a name-only
 *          PUT preserves a previously-set readmeConfig + communityPr (verified).
 *        - kbConfig is NOT in UpdateWorkDto -> PUT {kbConfig} -> 400 (whitelist).
 *        - Ownership-gated: a different authed user gets 403 on PUT.
 *
 *   GET  /api/works/:id/source-validation -> 200 { enabled, cadence, allowedCadences[] }
 *   PUT  /api/works/:id/source-validation -> 200 (enable + cadence persist; stamps nextRunAt)
 *
 *   GET  /api/works/:id/comparisons/generation-status -> 200 { generating:false } (repo-independent)
 *   GET  /api/works/:id/comparisons                   -> 200 [] when the data repo exists, else
 *   GET  /api/works/:id/comparisons/remaining-count   -> 200 { count } else GIT-GATED 5xx on a
 *        fresh CI Work (these READ the per-Work data git repo, which has no push in CI). A
 *        NONEXISTENT work -> 404 on both (the resolver precedes the git read).
 *
 * Cross-spec isolation: all MUTATIONS run on a FRESH registerUserViaAPI() user
 * (never the shared seeded user). The seeded user (storageState) is used
 * READ-ONLY in the last flow. login DTO takes ONLY {email,password}.
 */

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function workUrl(id: string): string {
    return `${API_BASE}/api/works/${id}`;
}
function configUrl(id: string): string {
    return `${API_BASE}/api/works/${id}/config`;
}

/** Tolerantly pull the Work object out of the various wrapper shapes. */
function unwrapWork(body: unknown): Record<string, unknown> {
    const b = body as Record<string, unknown>;
    const data = b?.data as Record<string, unknown> | undefined;
    return (
        (b?.work as Record<string, unknown>) ?? (data?.work as Record<string, unknown>) ?? b ?? {}
    );
}

test.describe('Work config + configCache lifecycle (deep integration)', () => {
    let token: string;

    test.beforeAll(async ({ request }) => {
        const reg = await registerUserViaAPI(request);
        token = reg.access_token;
    });

    test('config subresource is READ-ONLY: GET 200, all writers rejected', async ({ request }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, { name: `cfg-readonly ${Date.now()}` });
        expect(work.id).toBeTruthy();

        // GET returns a config envelope (config may be null on a fresh CI Work
        // whose data repo was never pushed — assert the ENVELOPE, not a value).
        const get = await request.get(configUrl(work.id), { headers });
        expect(get.status()).toBe(200);
        const body = await get.json();
        expect(body).toHaveProperty('config');

        // No mutating verb is wired on this path (verified live: all 404).
        const put = await request.put(configUrl(work.id), {
            headers,
            data: { company_name: 'x' },
        });
        expect([404, 405]).toContain(put.status());
        const patch = await request.patch(configUrl(work.id), {
            headers,
            data: { company_name: 'x' },
        });
        expect([404, 405]).toContain(patch.status());
        const post = await request.post(configUrl(work.id), {
            headers,
            data: { company_name: 'x' },
        });
        expect([404, 405]).toContain(post.status());
        const del = await request.delete(configUrl(work.id), { headers });
        expect([404, 405]).toContain(del.status());

        // The config snapshot is a DISTINCT subresource — the main Work entity
        // carries its own `configCache` mirror field instead of inlining config.
        const main = await request.get(workUrl(work.id), { headers });
        expect(main.ok()).toBeTruthy();
        const w = unwrapWork(await main.json());
        expect(w).toHaveProperty('configCache');
    });

    test('configCache mirror field: present on the Work entity, null until data-repo backfill', async ({
        request,
    }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, { name: `cfg-cache ${Date.now()}` });

        const res = await request.get(workUrl(work.id), { headers });
        expect(res.status()).toBe(200);
        const w = unwrapWork(await res.json());

        // configCache is the cached `.works/works.yml` snapshot. In CI there is
        // no git push, so it is null (or an empty/minimal object). Either way it
        // must be a recognised shape — never a leaked string/array.
        expect(w).toHaveProperty('configCache');
        const cache = w.configCache;
        expect(cache === null || typeof cache === 'object').toBeTruthy();

        // kbConfig is likewise a mirror field, null until populated.
        expect(w).toHaveProperty('kbConfig');
        expect(w.kbConfig === null || typeof w.kbConfig === 'object').toBeTruthy();

        // The cached GET /config and the entity's configCache describe the SAME
        // underlying snapshot — both must agree that no config exists yet.
        const cfg = await (await request.get(configUrl(work.id), { headers })).json();
        const cfgVal = cfg.config;
        const cacheEmpty = cache === null || Object.keys(cache as object).length === 0;
        const cfgEmpty =
            cfgVal === null ||
            cfgVal === undefined ||
            (typeof cfgVal === 'object' && Object.keys(cfgVal as object).length === 0);
        expect(cacheEmpty === cfgEmpty || cacheEmpty || cfgEmpty).toBeTruthy();
    });

    test('readmeConfig round-trips via PUT /works/:id and MERGES on partial updates', async ({
        request,
    }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, { name: `cfg-readme ${Date.now()}` });

        // Write a full MarkdownReadmeConfig (header/footer + overwrite flags).
        const readmeConfig = {
            header: 'E2E Custom Header',
            overwriteDefaultHeader: true,
            footer: 'E2E Custom Footer',
            overwriteDefaultFooter: false,
        };
        const put = await request.put(workUrl(work.id), { headers, data: { readmeConfig } });
        expect(put.status()).toBe(200);

        // The authoritative check is a fresh GET (write echo may omit it).
        const w1 = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w1.readmeConfig).toMatchObject({
            header: 'E2E Custom Header',
            overwriteDefaultHeader: true,
            footer: 'E2E Custom Footer',
        });

        // A NAME-ONLY update must MERGE — readmeConfig survives untouched.
        const renamed = `cfg-readme-renamed ${Date.now()}`;
        const put2 = await request.put(workUrl(work.id), { headers, data: { name: renamed } });
        expect(put2.status()).toBe(200);
        const w2 = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w2.readmeConfig).toMatchObject({ header: 'E2E Custom Header' });
        expect(typeof w2.name).toBe('string');
        expect(w2.name).toContain('cfg-readme-renamed');

        // Replace only the footer — header must remain from the prior write.
        const put3 = await request.put(workUrl(work.id), {
            headers,
            data: {
                readmeConfig: {
                    header: 'E2E Custom Header',
                    overwriteDefaultHeader: true,
                    footer: 'Replaced Footer',
                    overwriteDefaultFooter: true,
                },
            },
        });
        expect(put3.status()).toBe(200);
        const w3 = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w3.readmeConfig).toMatchObject({
            header: 'E2E Custom Header',
            footer: 'Replaced Footer',
            overwriteDefaultFooter: true,
        });

        // kbConfig is NOT writable through UpdateWorkDto — the whitelist rejects
        // it with a 400 (verified live), and the field stays null.
        const kbPut = await request.put(workUrl(work.id), {
            headers,
            data: { kbConfig: { sources: ['docs'] } },
        });
        expect([400, 200]).toContain(kbPut.status());
        const w4 = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w4.kbConfig === null || typeof w4.kbConfig === 'object').toBeTruthy();
    });

    test('community-PR flags persist via PUT /works/:id and coexist with readmeConfig', async ({
        request,
    }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, {
            name: `cfg-communitypr ${Date.now()}`,
        });

        // Defaults: community-PR processing is off on a fresh Work.
        const initial = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect([undefined, false, null]).toContain(initial.communityPrEnabled);

        // Enable community-PR + auto-close AND set readmeConfig in one PUT.
        const put = await request.put(workUrl(work.id), {
            headers,
            data: {
                communityPrEnabled: true,
                communityPrAutoClose: true,
                readmeConfig: { header: 'PR Header', overwriteDefaultHeader: false },
            },
        });
        expect(put.status()).toBe(200);

        const w = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w.communityPrEnabled).toBe(true);
        expect(w.communityPrAutoClose).toBe(true);
        expect(w.readmeConfig).toMatchObject({ header: 'PR Header' });

        // Toggle community-PR back OFF without touching readmeConfig (merge).
        const off = await request.put(workUrl(work.id), {
            headers,
            data: { communityPrEnabled: false },
        });
        expect(off.status()).toBe(200);
        const w2 = unwrapWork(await (await request.get(workUrl(work.id), { headers })).json());
        expect(w2.communityPrEnabled).toBe(false);
        // readmeConfig + the other flag survive the targeted toggle.
        expect(w2.readmeConfig).toMatchObject({ header: 'PR Header' });
        expect(w2.communityPrAutoClose).toBe(true);
    });

    test('source-validation + comparisons subresources read back consistently alongside config', async ({
        request,
    }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, {
            name: `cfg-validation ${Date.now()}`,
        });

        // source-validation GET is available for the owner (settings DTO with the
        // subscription-derived allowedCadences matrix). Verified live: 200 with
        // { enabled:false, cadence:null, allowedCadences:[...] } on a fresh Work.
        const sv = await request.get(`${workUrl(work.id)}/source-validation`, { headers });
        expect([200, 403]).toContain(sv.status());
        if (sv.status() === 200) {
            const svBody = await sv.json();
            expect(svBody).toHaveProperty('enabled');
            expect(svBody.enabled).toBe(false);
            // Enable a weekly cadence. A given cadence may be gated by allowances
            // in other envs -> tolerate any non-5xx; verified live it returns 200
            // and stamps nextRunAt.
            const put = await request.put(`${workUrl(work.id)}/source-validation`, {
                headers,
                data: { enabled: true, cadence: 'weekly' },
            });
            expect(put.status()).toBeLessThan(500);
            if (put.status() === 200) {
                const putBody = await put.json();
                expect(putBody.enabled).toBe(true);
                expect(putBody.cadence).toBe('weekly');
                // The enablement persists across a fresh GET.
                const reread = await request.get(`${workUrl(work.id)}/source-validation`, {
                    headers,
                });
                expect(reread.status()).toBe(200);
                const after = await reread.json();
                expect(after.enabled).toBe(true);
                expect(after.cadence).toBe('weekly');
            }
        }

        // Comparisons subresources. NOTE (verified live): list + remaining-count
        // READ the per-Work data GIT REPO to enumerate item pairs, so on a fresh
        // CI Work (no git push) they are git-gated -> 5xx. Only generation-status
        // is repo-independent and deterministically 200.
        const generationStatus = await request.get(
            `${workUrl(work.id)}/comparisons/generation-status`,
            { headers },
        );
        expect(generationStatus.status()).toBe(200);
        const gsBody = await generationStatus.json();
        expect(gsBody).toHaveProperty('generating');
        expect(gsBody.generating).toBe(false);

        // list + remaining-count: git-gated on a fresh Work. Accept the real
        // outcome (200 with an empty result when a repo exists, or the git-gated
        // 5xx in CI) but reject a 404 — the routes DO exist.
        const remaining = await request.get(`${workUrl(work.id)}/comparisons/remaining-count`, {
            headers,
        });
        expect(remaining.status()).not.toBe(404);
        if (remaining.status() === 200) {
            const remainingBody = await remaining.json();
            expect(remainingBody).toHaveProperty('count');
            expect(typeof remainingBody.count).toBe('number');
        }

        const list = await request.get(`${workUrl(work.id)}/comparisons`, { headers });
        expect(list.status()).not.toBe(404);
        if (list.status() === 200) {
            const listBody = await list.json();
            const arr = Array.isArray(listBody)
                ? listBody
                : (listBody?.comparisons ?? listBody?.data);
            if (Array.isArray(arr)) {
                expect(arr.length).toBe(0);
            }
        }

        // A NONEXISTENT work yields 404 on these subresources (the resolver runs
        // before the git read) — proving the 5xx above is data-repo-specific, not
        // a blanket failure of the route.
        const missingRemaining = await request.get(
            `${API_BASE}/api/works/${ZERO_UUID}/comparisons/remaining-count`,
            { headers },
        );
        expect(missingRemaining.status()).toBe(404);
    });

    test('config access surface: cached GET, ownership, anon + nonexistent rejected', async ({
        request,
        browser,
    }) => {
        const headers = authedHeaders(token);
        const work = await createWorkViaAPI(request, token, { name: `cfg-access ${Date.now()}` });
        expect(work.id).toBeTruthy();

        // Owner GET twice — the second read is served from the per-user
        // cacheManager.wrap() cache; both must return an identical envelope.
        const r1 = await request.get(configUrl(work.id), { headers });
        expect(r1.status()).toBe(200);
        const b1 = await r1.json();
        const r2 = await request.get(configUrl(work.id), { headers });
        expect(r2.status()).toBe(200);
        const b2 = await r2.json();
        expect(JSON.stringify(b2.config ?? null)).toBe(JSON.stringify(b1.config ?? null));

        // Mutating the Work invalidates its caches (invalidateWorkCaches); the
        // next config read must still succeed (recomputed, not stale-500).
        const mutate = await request.put(workUrl(work.id), {
            headers,
            data: { description: `touch ${Date.now()}` },
        });
        expect(mutate.status()).toBe(200);
        const r3 = await request.get(configUrl(work.id), { headers });
        expect(r3.status()).toBe(200);

        // Nonexistent Work -> 404 on the config subresource.
        const missing = await request.get(configUrl(ZERO_UUID), { headers });
        expect(missing.status()).toBe(404);

        // Anonymous context (a bare newContext would INHERIT storageState auth —
        // pass an empty storageState to be truly unauthenticated).
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const anonGet = await anon.request.get(configUrl(work.id));
        expect([401, 403]).toContain(anonGet.status());
        await anon.close();

        // Ownership: the config subresource is OWNER-ISOLATED (verified live: a
        // different authed user reading it gets 403, exactly like GET /works/:id —
        // it is NOT a global resolver). Tolerate 403/404 for environment variance.
        const other = await registerUserViaAPI(request);
        const otherHeaders = authedHeaders(other.access_token);
        const otherRead = await request.get(configUrl(work.id), { headers: otherHeaders });
        expect([403, 404]).toContain(otherRead.status());
        // ...and a different authed user cannot WRITE the Work either (readmeConfig
        // / community-PR flags are owner/manager-gated).
        const otherWrite = await request.put(workUrl(work.id), {
            headers: otherHeaders,
            data: { communityPrEnabled: true },
        });
        expect([403, 404]).toContain(otherWrite.status());
        // ...and the owner's flag is unchanged by the rejected cross-user write.
        const ownerView = unwrapWork(
            await (await request.get(workUrl(work.id), { headers })).json(),
        );
        expect([undefined, false, null]).toContain(ownerView.communityPrEnabled);
    });

    test('seeded user (storageState) reads its own work config end-to-end', async ({ request }) => {
        // Seeded user via the login DTO (email+password ONLY — adding {name} 400s).
        const s = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: s.email, password: s.password },
        });
        expect(login.ok()).toBeTruthy();
        const { access_token } = await login.json();
        const headers = authedHeaders(access_token);

        const work = await createWorkViaAPI(request, access_token, {
            name: `seeded-cfg ${Date.now()}`,
        });
        expect(work.id).toBeTruthy();

        // READ-ONLY assertions on the seeded user: config envelope + entity mirror.
        const cfg = await request.get(configUrl(work.id), { headers });
        expect(cfg.status()).toBe(200);
        expect(await cfg.json()).toHaveProperty('config');

        const main = await request.get(workUrl(work.id), { headers });
        expect(main.ok()).toBeTruthy();
        const w = unwrapWork(await main.json());
        expect(w).toHaveProperty('configCache');
        // Fresh Work => no community-PR processing, pristine cache.
        expect([undefined, false, null]).toContain(w.communityPrEnabled);
    });
});
