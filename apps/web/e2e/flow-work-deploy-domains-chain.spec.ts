import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * FLOW: WORK → DEPLOY CAPABILITY → STATUS → DOMAINS → MANAGED-SUBDOMAIN CHAIN.
 *
 * This file walks ONE Work through the ENTIRE `/api/deploy` verb surface as a
 * single continuous journey and pins the CROSS-VERB COHERENCE invariants that
 * only emerge when the whole chain is exercised together — invariants no
 * single-subsystem sibling asserts. The stack is keyless/tokenless (sqlite
 * in-memory, no Vercel/k8s token, no managed DNS, `K8S_MANAGED_SUBDOMAIN` off),
 * so NOTHING ever actually deploys: we pin the CAPABILITY CONTRACT, the
 * precondition PARTITION, the provider-name RE-THREAD, batch ATOMICITY, and the
 * whole-surface ISOLATION LEDGER.
 *
 * ── NON-DUPLICATION (checked live against every sibling on 2026-07-21) ───────
 * The deploy feature is heavily covered; this file is deliberately DISJOINT and
 * owns the WHOLE-CHAIN COHERENCE angle, not any single verb's depth:
 *   - flow-deploy-capability-contract ..... provider facade shape + configured axis +
 *       correlation. THIS file never re-asserts the facade shape; it asserts how a
 *       provider PATCH re-threads the gate NAME across deploy+lookup+teams in lockstep.
 *   - flow-deploy-providers-token ......... providers list + validate-token per-user.
 *       THIS file only uses them to prove the account-GLOBAL vs per-Work axis.
 *   - flow-deploy-domains-check-deep ...... the 4 domain verbs' gate-ORDER + dual error
 *       envelopes + per-verb ownership. THIS file uses VALID domains only and asserts the
 *       domain sub-surface as ONE website-gated BAND contrasted against the open reads.
 *   - flow-deploy-works-teams-deep ........ the teams verbs + per-verb ownership.
 *   - flow-work-deploy-state .............. the deploy STATE MACHINE + redeploy + history.
 *   - flow-work-deploy-lifecycle-multistep  runtime-env / subdomain / cluster-source depth.
 *       THIS file re-frames those two sub-resources as a CHAIN pair (opposite editability
 *       on the same undeployed Work) and folds them into the whole-surface ledgers.
 *   - flow-plugin-deployment .............. configure-flips-the-gate + batch happy/ghost.
 * The NEW angles here: (1) the three-way precondition PARTITION of the whole surface
 * (open-read / website-gated / configure-gated / mode-gated) on ONE Work; (2) the
 * single-dial provider RE-THREAD across deploy+lookup+teams simultaneously; (3) batch
 * ownership ATOMICITY (ghost→404, foreign→403 reject the WHOLE batch before any
 * dispatch); (4) the FULL-surface isolation LEDGERS (foreign 403 / ghost 404 / anon
 * 401 / malformed 400 as four uniform sweeps); (5) the whole-chain "nothing spuriously
 * deployed" invariant read off the Work's deploy columns after the entire walk.
 *
 * ── PROBED CONTRACTS (verified live at http://127.0.0.1:3100, 2026-07-21) ─────
 *  Fresh Work is born deployProvider:'vercel', website/deploymentState/deployProjectId/
 *    lastDeployCorrelationId/managedSubdomain all null.
 *  OPEN read surface on an undeployed+unconfigured Work:
 *    POST /deploy/works/:id/check          → 201 { status:'success', canDeploy:false,
 *          isShared:false, ownerHasToken:false, userHasToken:false }
 *    GET  /deploy/works/:id/deployments    → 200 { status:'success', deployments:[] }
 *    GET  /deploy/works/:id/subdomain      → 200 { subdomain:null, fqdn:null, url:null,
 *          recordOk:false, editable:false }
 *    GET  /deploy/works/:id/runtime-env    → 200 { status:'success',
 *          databaseUrl:{ configured:false, masked:null }, managed:[AUTH_SECRET,COOKIE_SECRET,COOKIE_SECURE] }
 *    PUT  /deploy/works/:id/runtime-env    → 200 masks password (user:***@host/db), redeploy hint
 *  WEBSITE-GATED band (work.website === null) — SAME copy on all four domain verbs:
 *    GET/POST /domains, DELETE/POST /domains/:domain[/verify] (VALID domain) →
 *          400 { status:'error', message:'No deployment exists for this work...' }
 *  CONFIGURE-GATED actions (no token) — 400, verb-specific copy:
 *    POST /deploy/works/:id                → 'Vercel token is required. Please configure it...'
 *    POST /deploy/works/:id/lookup         → 'Vercel token is required to lookup deployments...'
 *    POST /deploy/works/:id/teams          → 'Failed to get teams. Please configure your Vercel token...'
 *  MODE-GATED sub-resource:
 *    PUT  /deploy/works/:id/subdomain (valid label) → 400 'Managed subdomain is not editable...'
 *    (reserved label 'admin' → 400 blocklist copy BEFORE editable; bad chars/len/extra-key → DTO 400)
 *  Provider dial: PATCH /api/works/:id { deployProvider } whitelists 'k8s'/'vercel',
 *    rejects 'ever-works'/bogus 400 'Unsupported deploy provider: <v>'. A k8s work renames
 *    the deploy+lookup+teams gate copy 'Vercel'→'Kubernetes'; check stays name-agnostic.
 *  Batch POST /deploy/batch { works:[{workId}] }: all-own-undeployable → 201 status:'error',
 *    totalRequested/successfullyStarted:0/failed, results[i]={workId,slug,status:'error',message};
 *    a GHOST item → 404, a FOREIGN item → 403 (ownership pre-check rejects the WHOLE batch);
 *    missing works→400, non-array→400, item-missing-workId→400, empty→201 status:'success'/0.
 *  Rollback POST /deploy/works/:id/rollback { deploymentId:@IsUUID }: bad-uuid/empty → DTO 400;
 *    well-formed-but-absent → 400 'Deployment not found for this work.'
 *  Isolation: FOREIGN caller → 403 'You do not have permission to access this work' on EVERY
 *    per-work verb; GHOST (unknown uuid) → 404 "Work with id '..' not found"; ANON → 401;
 *    malformed :id → 400 (ParseUUIDPipe). Account-global providers/cluster-sources/validate-token
 *    → 401 anon, and are unaffected by any Work's deployProvider.
 *
 * Cross-spec isolation: EVERY test builds on FRESH registerUserViaAPI() users with unique
 * suffixes; list/ledger assertions use the caller's OWN ids and toContain/exact shapes —
 * never global counts. No module-scope data loading.
 */

const DEPLOY = `${API_BASE}/api/deploy`;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const MANAGED_KEYS = ['AUTH_SECRET', 'COOKIE_SECRET', 'COOKIE_SECURE'];

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

async function newWork(request: APIRequestContext, token: string, label = 'Deploy Chain') {
    const s = stamp();
    return createWorkViaAPI(request, token, { name: `${label} ${s}`, slug: `deploy-chain-${s}` });
}

/** Read the raw Work row (unwraps the { work } envelope). */
async function readWork(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, { headers: authedHeaders(token) });
    expect(res.status(), `read work ${id}`).toBe(200);
    const body = (await res.json()) as { work?: Record<string, unknown> };
    return body.work ?? (body as Record<string, unknown>);
}

/** Re-bind a Work to a deploy provider (whitelist: 'k8s' | 'vercel'). */
async function patchProvider(
    request: APIRequestContext,
    token: string,
    id: string,
    deployProvider: string,
) {
    return request.patch(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
        data: { deployProvider },
    });
}

/**
 * The whole per-Work deploy verb surface, as a table. `expectForeign` /
 * `expectGhost` are the ownership-layer answers; anon is uniformly 401; the
 * `uuidGuarded` verbs additionally 400 a malformed :id. Bodies are chosen so
 * the DTO/format layer PASSES and the ownership layer is what actually fires.
 */
interface Verb {
    name: string;
    call: (
        request: APIRequestContext,
        headersOrNone: Record<string, string> | undefined,
        id: string,
    ) => Promise<import('@playwright/test').APIResponse>;
    uuidGuarded: boolean;
}

const PER_WORK_VERBS: Verb[] = [
    {
        name: 'deploy',
        uuidGuarded: true,
        call: (r, h, id) => r.post(`${DEPLOY}/works/${id}`, { headers: h, data: {} }),
    },
    {
        name: 'check',
        uuidGuarded: true,
        call: (r, h, id) => r.post(`${DEPLOY}/works/${id}/check`, { headers: h }),
    },
    {
        name: 'lookup',
        uuidGuarded: true,
        call: (r, h, id) => r.post(`${DEPLOY}/works/${id}/lookup`, { headers: h }),
    },
    {
        name: 'deployments',
        uuidGuarded: true,
        call: (r, h, id) => r.get(`${DEPLOY}/works/${id}/deployments`, { headers: h }),
    },
    {
        name: 'domains-list',
        uuidGuarded: true,
        call: (r, h, id) => r.get(`${DEPLOY}/works/${id}/domains`, { headers: h }),
    },
    {
        name: 'subdomain-get',
        uuidGuarded: true,
        call: (r, h, id) => r.get(`${DEPLOY}/works/${id}/subdomain`, { headers: h }),
    },
    {
        name: 'subdomain-put',
        uuidGuarded: true,
        call: (r, h, id) =>
            r.put(`${DEPLOY}/works/${id}/subdomain`, {
                headers: h,
                data: { subdomain: `x${stamp().replace(/-/g, '')}`.slice(0, 40) },
            }),
    },
    {
        name: 'runtime-env-get',
        uuidGuarded: true,
        call: (r, h, id) => r.get(`${DEPLOY}/works/${id}/runtime-env`, { headers: h }),
    },
    {
        name: 'runtime-env-put',
        uuidGuarded: true,
        call: (r, h, id) =>
            r.put(`${DEPLOY}/works/${id}/runtime-env`, {
                headers: h,
                data: { databaseUrl: 'postgresql://u:p@db.example.com:5432/app' },
            }),
    },
    {
        name: 'teams',
        uuidGuarded: true,
        call: (r, h, id) => r.post(`${DEPLOY}/works/${id}/teams`, { headers: h }),
    },
    {
        name: 'rollback',
        uuidGuarded: true,
        call: (r, h, id) =>
            r.post(`${DEPLOY}/works/${id}/rollback`, {
                headers: h,
                data: { deploymentId: UNKNOWN_UUID },
            }),
    },
];

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — precondition partition on one undeployed Work', () => {
    test('the OPEN read surface (check / deployments / subdomain / runtime-env) resolves a coherent idle snapshot with NO prior deploy', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const work = await newWork(request, token);

        // check — capability read, always available, all-false for a fresh user.
        const check = await request.post(`${DEPLOY}/works/${work.id}/check`, {
            headers: authedHeaders(token),
        });
        expect(check.status()).toBe(201);
        expect(await check.json()).toMatchObject({
            status: 'success',
            canDeploy: false,
            isShared: false,
            ownerHasToken: false,
            userHasToken: false,
        });

        // deployments — history list, empty (never deployed).
        const deployments = await request.get(`${DEPLOY}/works/${work.id}/deployments`, {
            headers: authedHeaders(token),
        });
        expect(deployments.status()).toBe(200);
        expect(await deployments.json()).toEqual({ status: 'success', deployments: [] });

        // subdomain — idle null-state.
        const sub = await request.get(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: authedHeaders(token),
        });
        expect(sub.status()).toBe(200);
        expect(await sub.json()).toEqual({
            subdomain: null,
            fqdn: null,
            url: null,
            recordOk: false,
            editable: false,
        });

        // runtime-env — unconfigured, managed keys advertised (not editable here).
        const rt = await request.get(`${DEPLOY}/works/${work.id}/runtime-env`, {
            headers: authedHeaders(token),
        });
        expect(rt.status()).toBe(200);
        const rtBody = (await rt.json()) as {
            status: string;
            databaseUrl: { configured: boolean; masked: string | null };
            managed: string[];
        };
        expect(rtBody.status).toBe('success');
        expect(rtBody.databaseUrl).toEqual({ configured: false, masked: null });
        expect(rtBody.managed).toEqual(MANAGED_KEYS);
    });

    test('the WEBSITE-GATED band: all FOUR domain verbs refuse with the SAME "No deployment exists" copy while the read surface stayed open', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // VALID domain everywhere — so the website gate (not the format guard) is what fires.
        const listRes = await request.get(`${DEPLOY}/works/${work.id}/domains`, { headers: h });
        const addRes = await request.post(`${DEPLOY}/works/${work.id}/domains`, {
            headers: h,
            data: { domain: 'example.com' },
        });
        const removeRes = await request.delete(`${DEPLOY}/works/${work.id}/domains/example.com`, {
            headers: h,
        });
        const verifyRes = await request.post(
            `${DEPLOY}/works/${work.id}/domains/example.com/verify`,
            { headers: h },
        );

        for (const res of [listRes, addRes, removeRes, verifyRes]) {
            expect(res.status(), 'every domain verb is website-gated').toBe(400);
            const body = (await res.json()) as { status: string; message: string };
            expect(body.status).toBe('error');
            expect(body.message).toMatch(/No deployment exists for this work/i);
        }

        // The website gate is scoped to the domain band ONLY: the read surface on
        // the SAME work is still open (proving the precondition isn't global).
        expect(
            (await request.post(`${DEPLOY}/works/${work.id}/check`, { headers: h })).status(),
        ).toBe(201);
        expect(
            (await request.get(`${DEPLOY}/works/${work.id}/deployments`, { headers: h })).status(),
        ).toBe(200);
    });

    test('the CONFIGURE-GATED actions (deploy / lookup / teams) all 400 for one missing-credential cause, each with its OWN verb-specific copy', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        const deploy = await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} });
        expect(deploy.status()).toBe(400);
        expect(msgOf(await deploy.json())).toMatch(/Vercel token is required\. Please configure/i);

        const lookup = await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h });
        expect(lookup.status()).toBe(400);
        expect(msgOf(await lookup.json())).toMatch(/token is required to lookup deployments/i);

        const teams = await request.post(`${DEPLOY}/works/${work.id}/teams`, { headers: h });
        expect(teams.status()).toBe(400);
        expect(msgOf(await teams.json())).toMatch(
            /Failed to get teams.*configure your Vercel token/i,
        );

        // Same cause (no token), three DISTINCT verb-scoped messages — never a shared string.
        const deployMsg = msgOf(
            await (
                await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
            ).json(),
        );
        const lookupMsg = msgOf(
            await (await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h })).json(),
        );
        expect(deployMsg).not.toBe(lookupMsg);
    });

    test('the three refusal CAUSES are DISJOINT: a domain verb never cites a token, a configure verb never cites a missing deployment, subdomain-PUT cites neither', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        const domainMsg = msgOf(
            await (
                await request.post(`${DEPLOY}/works/${work.id}/domains`, {
                    headers: h,
                    data: { domain: 'example.com' },
                })
            ).json(),
        );
        const deployMsg = msgOf(
            await (
                await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
            ).json(),
        );
        const subMsg = msgOf(
            await (
                await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
                    headers: h,
                    data: { subdomain: 'my-cool-site' },
                })
            ).json(),
        );

        // Website gate: talks about deployment, NOT tokens.
        expect(domainMsg).toMatch(/No deployment exists/i);
        expect(domainMsg).not.toMatch(/token/i);
        // Configure gate: talks about tokens, NOT a missing deployment.
        expect(deployMsg).toMatch(/token is required/i);
        expect(deployMsg).not.toMatch(/No deployment exists/i);
        // Mode gate: talks about editability, neither tokens nor deployment.
        expect(subMsg).toMatch(/not editable/i);
        expect(subMsg).not.toMatch(/token|No deployment exists/i);
    });

    test('the two per-Work sub-resources have OPPOSITE write-availability pre-deploy: runtime-env is EDITABLE, subdomain is NOT — and neither publishes a website', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // runtime-env PUT succeeds pre-deploy (200) and masks the credential.
        const rt = await request.put(`${DEPLOY}/works/${work.id}/runtime-env`, {
            headers: h,
            data: {
                databaseUrl: 'postgresql://user:secret@db.example.com:5432/mydb?sslmode=require',
            },
        });
        expect(rt.status()).toBe(200);
        const rtBody = (await rt.json()) as {
            status: string;
            databaseUrl: { configured: boolean; masked: string | null };
            message: string;
        };
        expect(rtBody.status).toBe('success');
        expect(rtBody.databaseUrl.configured).toBe(true);
        expect(rtBody.databaseUrl.masked).toBe('postgresql://user:***@db.example.com:5432/mydb');
        expect(rtBody.databaseUrl.masked).not.toContain('secret');
        expect(rtBody.message).toMatch(/Redeploy to apply/i);

        // subdomain PUT is refused on the SAME work (managed mode off) — opposite editability.
        const sub = await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: h,
            data: { subdomain: 'my-cool-site' },
        });
        expect(sub.status()).toBe(400);
        expect(msgOf(await sub.json())).toMatch(/not editable/i);

        // Neither sub-resource write published a website or moved the deploy state.
        const after = await readWork(request, token, work.id);
        expect(after.website ?? null).toBeNull();
        expect(after.deploymentState ?? null).toBeNull();
        expect(after.managedSubdomain ?? null).toBeNull();
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — the provider dial re-threads the whole gate', () => {
    test('flipping deployProvider vercel→k8s re-threads the gate NAME in LOCKSTEP across deploy + lookup + teams, while check stays name-agnostic', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // Before: every gate names Vercel (the default provider).
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
                ).json(),
            ),
        ).toMatch(/Vercel token is required/i);
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h })
                ).json(),
            ),
        ).toMatch(/Vercel token is required to lookup/i);
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}/teams`, { headers: h })
                ).json(),
            ),
        ).toMatch(/configure your Vercel token/i);

        // Turn the ONE dial.
        const patch = await patchProvider(request, token, work.id, 'k8s');
        expect(patch.status()).toBe(200);
        expect(
            ((await patch.json()) as { work: { deployProvider: string } }).work.deployProvider,
        ).toBe('k8s');

        // After: all THREE action gates rename Vercel→Kubernetes together.
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
                ).json(),
            ),
        ).toMatch(/Kubernetes token is required/i);
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h })
                ).json(),
            ),
        ).toMatch(/Kubernetes token is required to lookup/i);
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}/teams`, { headers: h })
                ).json(),
            ),
        ).toMatch(/configure your Kubernetes token/i);

        // check is provider-name-AGNOSTIC — its boolean capability shape is unchanged.
        const check = await request.post(`${DEPLOY}/works/${work.id}/check`, { headers: h });
        expect(check.status()).toBe(201);
        expect(await check.json()).toMatchObject({
            status: 'success',
            canDeploy: false,
            ownerHasToken: false,
            userHasToken: false,
        });
    });

    test('a REJECTED provider PATCH (ever-works alias / bogus) leaves the chain gate naming the ORIGINAL provider', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // 'ever-works' is a READ-side alias, not a settable provider; 'heroku' is unknown.
        for (const bad of ['ever-works', 'heroku']) {
            const res = await patchProvider(request, token, work.id, bad);
            expect(res.status(), `PATCH deployProvider=${bad}`).toBe(400);
            expect(msgOf(await res.json())).toMatch(
                new RegExp(`Unsupported deploy provider: ${bad}`, 'i'),
            );
        }

        // The rejected writes changed nothing: provider is still vercel and the gate proves it.
        expect((await readWork(request, token, work.id)).deployProvider as string).toBe('vercel');
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })
                ).json(),
            ),
        ).toMatch(/Vercel token is required/i);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — per-Work sub-resource coherence', () => {
    test('runtime-env set→GET round-trips the SAME masked value; a non-postgres string is DTO-rejected', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        const put = await request.put(`${DEPLOY}/works/${work.id}/runtime-env`, {
            headers: h,
            data: { databaseUrl: 'postgres://svc:pw@10.0.0.5:5432/prod' },
        });
        expect(put.status()).toBe(200);
        const masked = ((await put.json()) as { databaseUrl: { masked: string } }).databaseUrl
            .masked;
        expect(masked).toBe('postgres://svc:***@10.0.0.5:5432/prod');

        // GET reflects the SAME masked value — the write is read-back coherent.
        const get = await request.get(`${DEPLOY}/works/${work.id}/runtime-env`, { headers: h });
        expect(get.status()).toBe(200);
        const getBody = (await get.json()) as {
            databaseUrl: { configured: boolean; masked: string };
            managed: string[];
        };
        expect(getBody.databaseUrl.configured).toBe(true);
        expect(getBody.databaseUrl.masked).toBe(masked);
        expect(getBody.managed).toEqual(MANAGED_KEYS);

        // A mysql URL is rejected by the @Matches DTO — the single validation message.
        const bad = await request.put(`${DEPLOY}/works/${work.id}/runtime-env`, {
            headers: h,
            data: { databaseUrl: 'mysql://u:p@h/db' },
        });
        expect(bad.status()).toBe(400);
        expect(msgOf(await bad.json())).toMatch(/must be a postgres:\/\/ or postgresql:\/\//i);
        // The rejected write did not clobber the previously-stored value.
        const stillSet = await request.get(`${DEPLOY}/works/${work.id}/runtime-env`, {
            headers: h,
        });
        expect(
            ((await stillSet.json()) as { databaseUrl: { masked: string } }).databaseUrl.masked,
        ).toBe(masked);
    });

    test('runtime-env is strictly PER-WORK: configuring one chain Work never leaks into a sibling Work', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const a = await newWork(request, token, 'Chain A');
        const b = await newWork(request, token, 'Chain B');

        await request.put(`${DEPLOY}/works/${a.id}/runtime-env`, {
            headers: h,
            data: { databaseUrl: 'postgresql://a:a@a-host:5432/adb' },
        });

        const aGet = await request.get(`${DEPLOY}/works/${a.id}/runtime-env`, { headers: h });
        const bGet = await request.get(`${DEPLOY}/works/${b.id}/runtime-env`, { headers: h });
        expect(
            ((await aGet.json()) as { databaseUrl: { configured: boolean } }).databaseUrl
                .configured,
        ).toBe(true);
        // Sibling stays pristine — no cross-work bleed.
        expect(await bGet.json()).toMatchObject({
            databaseUrl: { configured: false, masked: null },
        });
    });

    test('the managed-subdomain GET derives fqdn/url from a null label — the whole derivation chain collapses to null when unallocated', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const work = await newWork(request, token);

        const res = await request.get(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
            subdomain: string | null;
            fqdn: string | null;
            url: string | null;
            recordOk: boolean;
            editable: boolean;
        };
        // subdomain null ⇒ fqdn null ⇒ url null ⇒ recordOk false; editable false (managed mode off).
        expect(body.subdomain).toBeNull();
        expect(body.fqdn).toBeNull();
        expect(body.url).toBeNull();
        expect(body.recordOk).toBe(false);
        expect(body.editable).toBe(false);
    });

    test('the subdomain PUT guard precedence ladder: DTO-format → reserved-blocklist → not-editable, each a DISTINCT 400 body; an extra key is forbidNonWhitelisted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // (1) DTO format layer — bad chars / leading dash / >63 chars → class-validator array envelope.
        for (const label of ['Bad_Label', '-nope', 'a'.repeat(64)]) {
            const res = await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
                headers: h,
                data: { subdomain: label },
            });
            expect(res.status(), `format reject ${label}`).toBe(400);
            const body = (await res.json()) as { message: string[]; error: string };
            expect(Array.isArray(body.message)).toBe(true);
            expect(body.error).toBe('Bad Request');
        }

        // (2) blocklist layer — a VALID-format reserved label is rejected with the service
        //     blocklist copy BEFORE the not-editable check (so this fires even though the
        //     work is not editable) — proving the ordering.
        const reserved = await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: h,
            data: { subdomain: 'admin' },
        });
        expect(reserved.status()).toBe(400);
        expect(msgOf(await reserved.json())).toMatch(/"admin" is reserved by the platform/i);

        // (3) not-editable layer — a VALID, non-reserved label reaches the editable check.
        const notEditable = await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: h,
            data: { subdomain: 'totally-fine-label' },
        });
        expect(notEditable.status()).toBe(400);
        expect(msgOf(await notEditable.json())).toMatch(/not editable/i);

        // forbidNonWhitelisted — an extra body key is a DTO 400 regardless of label validity.
        const extra = await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
            headers: h,
            data: { subdomain: 'okname', bogus: 1 },
        });
        expect(extra.status()).toBe(400);
        expect(msgOf(await extra.json())).toMatch(/property bogus should not exist/i);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — batch as a multi-Work chain', () => {
    test('a batch of the caller`s OWN undeployable Works returns the error envelope with a per-Work result row for each', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const one = await newWork(request, token, 'Batch One');
        const two = await newWork(request, token, 'Batch Two');

        const res = await request.post(`${DEPLOY}/batch`, {
            headers: authedHeaders(token),
            data: { works: [{ workId: one.id }, { workId: two.id }] },
        });
        expect(res.status()).toBe(201);
        const body = (await res.json()) as {
            status: string;
            totalRequested: number;
            successfullyStarted: number;
            failed: number;
            results: Array<{ workId: string; slug: string; status: string; message: string }>;
        };
        // Keyless: nothing dispatches, so the aggregate is a full-failure 'error' envelope.
        expect(body.status).toBe('error');
        expect(body.totalRequested).toBe(2);
        expect(body.successfullyStarted).toBe(0);
        expect(body.failed).toBe(2);
        expect(body.results).toHaveLength(2);
        const ids = body.results.map((r) => r.workId);
        expect(ids).toContain(one.id);
        expect(ids).toContain(two.id);
        for (const row of body.results) {
            expect(row.status).toBe('error');
            expect(typeof row.slug).toBe('string');
            expect(typeof row.message).toBe('string');
        }
    });

    test('batch ownership is ATOMIC: a GHOST item → 404 and a FOREIGN item → 403 reject the WHOLE batch before any dispatch (the good Work is untouched)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const token = owner.access_token;
        const good = await newWork(request, token, 'Batch Good');
        const foreign = await newWork(request, stranger.access_token, 'Batch Foreign');

        // A ghost id anywhere in the list rejects the whole batch → 404.
        const ghost = await request.post(`${DEPLOY}/batch`, {
            headers: authedHeaders(token),
            data: { works: [{ workId: good.id }, { workId: UNKNOWN_UUID }] },
        });
        expect(ghost.status()).toBe(404);
        expect(msgOf(await ghost.json())).toMatch(/Work with id .* not found/i);

        // A foreign-owned id anywhere in the list rejects the whole batch → 403 (never 404).
        const foreignBatch = await request.post(`${DEPLOY}/batch`, {
            headers: authedHeaders(token),
            data: { works: [{ workId: good.id }, { workId: foreign.id }] },
        });
        expect(foreignBatch.status()).toBe(403);
        expect(msgOf(await foreignBatch.json())).toMatch(/do not have permission/i);

        // Atomicity: the good Work never deployed — its deploy columns stay idle.
        const after = await readWork(request, token, good.id);
        expect(after.website ?? null).toBeNull();
        expect(after.deploymentState ?? null).toBeNull();
        expect(after.lastDeployCorrelationId ?? null).toBeNull();
    });

    test('batch DTO validation: missing/non-array `works` → 400, an item missing workId → 400, and an EMPTY batch is a zeroed success', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);

        const missing = await request.post(`${DEPLOY}/batch`, { headers: h, data: {} });
        expect(missing.status()).toBe(400);
        expect(msgOf(await missing.json())).toMatch(/works must be an array/i);

        const notArray = await request.post(`${DEPLOY}/batch`, {
            headers: h,
            data: { works: 'nope' },
        });
        expect(notArray.status()).toBe(400);

        const badItem = await request.post(`${DEPLOY}/batch`, {
            headers: h,
            data: { works: [{}] },
        });
        expect(badItem.status()).toBe(400);
        expect(msgOf(await badItem.json())).toMatch(/works\.0\.workId must be a string/i);

        // An empty list is a legal no-op: a zeroed 'success' envelope, no results.
        const empty = await request.post(`${DEPLOY}/batch`, { headers: h, data: { works: [] } });
        expect(empty.status()).toBe(201);
        expect(await empty.json()).toMatchObject({
            status: 'success',
            totalRequested: 0,
            successfullyStarted: 0,
            failed: 0,
            results: [],
        });
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — rollback coherence with the (empty) history', () => {
    test('with an EMPTY deployment history, every well-formed rollback is "Deployment not found"; a bad/empty deploymentId is a DTO 400 — and nothing is written', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // History is empty (asserted), so no deploymentId can ever resolve for this work.
        const history = await request.get(`${DEPLOY}/works/${work.id}/deployments`, { headers: h });
        expect(await history.json()).toEqual({ status: 'success', deployments: [] });

        // Well-formed-but-absent deploymentId → 400 "Deployment not found for this work."
        const absent = await request.post(`${DEPLOY}/works/${work.id}/rollback`, {
            headers: h,
            data: { deploymentId: UNKNOWN_UUID },
        });
        expect(absent.status()).toBe(400);
        expect(msgOf(await absent.json())).toMatch(/Deployment not found for this work/i);

        // Non-uuid deploymentId → DTO 400 (a different, earlier layer).
        const badUuid = await request.post(`${DEPLOY}/works/${work.id}/rollback`, {
            headers: h,
            data: { deploymentId: 'not-a-uuid' },
        });
        expect(badUuid.status()).toBe(400);
        expect(msgOf(await badUuid.json())).toMatch(/deploymentId must be a UUID/i);

        // Empty body → the full DTO validation stack (not-empty + uuid).
        const emptyBody = await request.post(`${DEPLOY}/works/${work.id}/rollback`, {
            headers: h,
            data: {},
        });
        expect(emptyBody.status()).toBe(400);

        // Every rejected rollback wrote nothing to the deploy state machine.
        const after = await readWork(request, token, work.id);
        expect(after.deploymentState ?? null).toBeNull();
        expect(after.lastDeployCorrelationId ?? null).toBeNull();
        expect(
            (
                (await (
                    await request.get(`${DEPLOY}/works/${work.id}/deployments`, { headers: h })
                ).json()) as {
                    deployments: unknown[];
                }
            ).deployments,
        ).toHaveLength(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — whole-surface isolation ledgers', () => {
    test('a FOREIGN caller gets a UNIFORM 403 across the ENTIRE per-Work verb surface (no leak, never a 404)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await newWork(request, owner.access_token);
        const s = authedHeaders(stranger.access_token);

        const results: Array<{ name: string; status: number }> = [];
        for (const verb of PER_WORK_VERBS) {
            const res = await verb.call(request, s, work.id);
            results.push({ name: verb.name, status: res.status() });
        }
        // EVERY verb answers 403 for a real-but-foreign work — the ownership layer
        // fires before any website / configure / DTO gate.
        for (const r of results) {
            expect(r.status, `foreign ${r.name} → expected 403, got ${r.status}`).toBe(403);
        }
        // And a foreign batch (single foreign item) is 403 too.
        const batch = await request.post(`${DEPLOY}/batch`, {
            headers: s,
            data: { works: [{ workId: work.id }] },
        });
        expect(batch.status()).toBe(403);
        expect(msgOf(await batch.json())).toMatch(/do not have permission/i);
    });

    test('a GHOST (unknown-uuid) Work gets a UNIFORM 404 across the same surface — the 403-vs-404 split distinguishes foreign from missing', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const verb of PER_WORK_VERBS) {
            const res = await verb.call(request, h, UNKNOWN_UUID);
            expect(res.status(), `ghost ${verb.name} → expected 404, got ${res.status()}`).toBe(
                404,
            );
        }
        // Batch with a ghost item → 404 as well.
        const batch = await request.post(`${DEPLOY}/batch`, {
            headers: h,
            data: { works: [{ workId: UNKNOWN_UUID }] },
        });
        expect(batch.status()).toBe(404);
        expect(msgOf(await batch.json())).toMatch(/Work with id .* not found/i);
    });

    test('ANON (no token) gets a UNIFORM 401 across the per-Work surface AND the account-global verbs', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const work = await newWork(request, user.access_token);

        // Per-work surface, unauthenticated.
        for (const verb of PER_WORK_VERBS) {
            const res = await verb.call(request, undefined, work.id);
            expect(res.status(), `anon ${verb.name} → expected 401, got ${res.status()}`).toBe(401);
        }
        // Account-global verbs (no work id) are auth-guarded too.
        expect((await request.get(`${DEPLOY}/providers`)).status()).toBe(401);
        expect((await request.get(`${DEPLOY}/cluster-sources`)).status()).toBe(401);
        expect((await request.post(`${DEPLOY}/validate-token`)).status()).toBe(401);
        expect((await request.post(`${DEPLOY}/batch`, { data: { works: [] } })).status()).toBe(401);
    });

    test('a MALFORMED :id is a UNIFORM ParseUUIDPipe 400 across the surface — the format guard fires before ownership/website/configure logic', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const h = authedHeaders(user.access_token);

        for (const verb of PER_WORK_VERBS.filter((v) => v.uuidGuarded)) {
            const res = await verb.call(request, h, 'not-a-uuid');
            expect(res.status(), `malformed ${verb.name} → expected 400, got ${res.status()}`).toBe(
                400,
            );
        }
    });
});

// ────────────────────────────────────────────────────────────────────────────
test.describe('Deploy chain — structural axis + end-to-end invariant', () => {
    test('the account-GLOBAL verbs (providers / cluster-sources / validate-token) need NO Work and are UNAFFECTED by any Work`s deployProvider', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const work = await newWork(request, token);

        const readGlobals = async () => {
            const providers = await request.get(`${DEPLOY}/providers`, {
                headers: authedHeaders(token),
            });
            const cluster = await request.get(`${DEPLOY}/cluster-sources`, {
                headers: authedHeaders(token),
            });
            const validate = await request.post(`${DEPLOY}/validate-token`, {
                headers: authedHeaders(token),
            });
            return {
                providers: (await providers.json()) as {
                    status: string;
                    providers: Array<{ id: string; enabled: boolean; configured: boolean }>;
                },
                cluster: (await cluster.json()) as {
                    status: string;
                    clusterSources: Array<{ value: string }>;
                },
                validate: (await validate.json()) as { status: string; valid: boolean },
            };
        };

        const before = await readGlobals();
        // providers: the two built-ins, both enabled, unconfigured for a fresh user.
        expect(before.providers.status).toBe('success');
        expect(before.providers.providers.map((p) => p.id).sort()).toEqual(['k8s', 'vercel']);
        expect(before.providers.providers.every((p) => p.enabled && !p.configured)).toBe(true);
        // cluster-sources: the non-admin option set — includes the shared + custom, OMITS admin-only k8s-works.
        const clusterValues = before.cluster.clusterSources.map((c) => c.value);
        expect(clusterValues).toContain('custom-kubeconfig');
        expect(clusterValues).not.toContain('k8s-works');
        // validate-token: no provider configured → valid:false.
        expect(before.validate).toMatchObject({ status: 'success', valid: false });

        // Re-bind the Work to k8s — a PER-WORK change.
        expect((await patchProvider(request, token, work.id, 'k8s')).status()).toBe(200);

        // The account-global reads are IDENTICAL — they are not keyed on any Work.
        const after = await readGlobals();
        expect(after.providers.providers.map((p) => p.id).sort()).toEqual(['k8s', 'vercel']);
        expect(after.cluster.clusterSources.map((c) => c.value)).toEqual(clusterValues);
        expect(after.validate.valid).toBe(false);
    });

    test('lookup and the domain verbs report DIFFERENT preconditions on the same undeployed Work — configure-gate vs website-gate — because lookup can DISCOVER a deployment', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // Both are "not yet deployed", but lookup checks the TOKEN (it could still find
        // a deployment via the provider) while domains assume a published website exists.
        const lookup = await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h });
        expect(lookup.status()).toBe(400);
        expect(msgOf(await lookup.json())).toMatch(/token is required to lookup/i);

        const domains = await request.get(`${DEPLOY}/works/${work.id}/domains`, { headers: h });
        expect(domains.status()).toBe(400);
        expect(msgOf(await domains.json())).toMatch(/No deployment exists/i);

        // Distinct causes on the very same work — never the same message.
        expect(
            msgOf(
                await (
                    await request.post(`${DEPLOY}/works/${work.id}/lookup`, { headers: h })
                ).json(),
            ),
        ).not.toMatch(/No deployment exists/i);
    });

    test('walking the ENTIRE chain (configure runtime-env, read the capability, attempt every write) leaves the Work`s deploy columns ALL idle — the surface is read/refuse-only without credentials', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const h = authedHeaders(token);
        const work = await newWork(request, token);

        // 1. Configure the one editable sub-resource.
        expect(
            (
                await request.put(`${DEPLOY}/works/${work.id}/runtime-env`, {
                    headers: h,
                    data: { databaseUrl: 'postgresql://u:p@db:5432/app' },
                })
            ).status(),
        ).toBe(200);
        // 2. Read the capability (open verbs).
        expect(
            (await request.post(`${DEPLOY}/works/${work.id}/check`, { headers: h })).status(),
        ).toBe(201);
        expect(
            (await request.get(`${DEPLOY}/works/${work.id}/deployments`, { headers: h })).status(),
        ).toBe(200);
        // 3. Attempt the managed-subdomain write (refused — not editable).
        expect(
            (
                await request.put(`${DEPLOY}/works/${work.id}/subdomain`, {
                    headers: h,
                    data: { subdomain: 'launch-me' },
                })
            ).status(),
        ).toBe(400);
        // 4. Attempt every domain write (refused — website gate).
        for (const attempt of [
            request.post(`${DEPLOY}/works/${work.id}/domains`, {
                headers: h,
                data: { domain: 'a.com' },
            }),
            request.delete(`${DEPLOY}/works/${work.id}/domains/a.com`, { headers: h }),
            request.post(`${DEPLOY}/works/${work.id}/domains/a.com/verify`, { headers: h }),
        ]) {
            expect((await attempt).status()).toBe(400);
        }
        // 5. Attempt the deploy + a rollback (both refused).
        expect(
            (await request.post(`${DEPLOY}/works/${work.id}`, { headers: h, data: {} })).status(),
        ).toBe(400);
        expect(
            (
                await request.post(`${DEPLOY}/works/${work.id}/rollback`, {
                    headers: h,
                    data: { deploymentId: UNKNOWN_UUID },
                })
            ).status(),
        ).toBe(400);

        // After the whole walk: the ONLY mutation was the runtime-env; every deploy
        // column stays idle — nothing spuriously published or dispatched.
        const after = await readWork(request, token, work.id);
        expect(after.website ?? null).toBeNull();
        expect(after.deploymentState ?? null).toBeNull();
        expect(after.deploymentStartedAt ?? null).toBeNull();
        expect(after.deployProjectId ?? null).toBeNull();
        expect(after.lastDeployCorrelationId ?? null).toBeNull();
        expect(after.managedSubdomain ?? null).toBeNull();
        // deployProvider is still the default — no write flipped it.
        expect(after.deployProvider).toBe('vercel');
        // History is still empty.
        const hist = (await (
            await request.get(`${DEPLOY}/works/${work.id}/deployments`, { headers: h })
        ).json()) as { deployments: unknown[] };
        expect(hist.deployments).toHaveLength(0);
    });
});
