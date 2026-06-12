import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: DEPLOY DOMAINS (+ check verb) — complex, multi-step, cross-feature
 * INTEGRATION flows pinning the deploy capability's DOMAIN-MANAGEMENT sub-verbs
 * and the per-verb GATE-ORDERING that the sibling deploy specs do NOT assert: the
 * FOUR domain verbs (GET list / POST add / DELETE remove / POST verify), the
 * website-gated "No deployment exists" refusal, and — critically — the THREE
 * distinct validation layers that fire in a precise, verb-specific ORDER:
 *   (a) the controller-level `DOMAIN_RE` path-param format guard on remove/verify
 *       (a `{ status:'error', message:'Invalid domain format...' }` envelope that
 *       runs BEFORE ownership — so a STRANGER hitting a malformed domain on a
 *       foreign work gets the format-400, not the ownership-403),
 *   (b) the `AddDomainDto` @Matches body validation on POST add (a DIFFERENT
 *       envelope — the global ValidationPipe's `{ message:[...], error:'Bad
 *       Request', statusCode:400 }` array shape + forbidNonWhitelisted),
 *   (c) the `ParseUUIDPipe` on the `:id` param (uuid-is-expected 400).
 * Then ownership (ensureCanView/Edit -> 403 foreign / 404 ghost / 401 anon) and
 * finally the website gate. THIS file pins the gate ORDER + the two distinct
 * error-envelope shapes + the full ownership cross-product on EACH of the
 * remove/verify/add verbs, plus a nothing-persisted invariant after the barrage.
 *
 * GROUNDING — every status/shape below was verified against the LIVE sqlite e2e
 * API (port 3100) with throwaway users on 2026-06-12, and cross-checked against
 * the real source:
 *   - apps/api/src/plugins-capabilities/deploy/deploy.controller.ts
 *       (listDomains/addDomain -> ensureCanView/Edit then `if (!work.website)`;
 *        removeDomain/verifyDomain -> `DOMAIN_RE.test(domain)` FIRST, THEN
 *        ensureCanEdit, THEN the website gate; every verb @Param('id', ParseUUIDPipe))
 *   - apps/api/src/plugins-capabilities/deploy/dto/domain.dto.ts
 *       (AddDomainDto { domain } @IsString @IsNotEmpty @Matches(<same DOMAIN_RE>))
 *
 *   Probed contract facts (asserted below, NOT guessed):
 *     GET  /api/deploy/works/:id/domains (website unset)
 *        → 400 { status:'error', message:'No deployment exists for this work. Deploy first...' }
 *     POST /api/deploy/works/:id/domains (website unset, VALID domain)
 *        → 400 { status:'error', message:/No deployment exists/ }
 *     POST /api/deploy/works/:id/domains  body { domain:'not a domain' }
 *        → 400 { message:['Invalid domain format. Example: example.com'], error:'Bad Request', statusCode:400 }
 *     POST /api/deploy/works/:id/domains  body {} (missing domain)
 *        → 400 { message:[/Invalid domain format/, 'domain should not be empty', 'domain must be a string'], ... }
 *     POST /api/deploy/works/:id/domains  body { domain:'ok.example.com', bogusKey:1 }
 *        → 400 { message:['property bogusKey should not exist'], ... } (forbidNonWhitelisted)
 *     DELETE /api/deploy/works/:id/domains/<valid> (website unset)
 *        → 400 { status:'error', message:/No deployment exists/ }
 *     DELETE /api/deploy/works/:id/domains/not_a_domain (INVALID format)
 *        → 400 { status:'error', message:'Invalid domain format. Example: example.com' }  (controller guard FIRST)
 *     POST /api/deploy/works/:id/domains/<valid>/verify (website unset)
 *        → 400 { status:'error', message:/No deployment exists/ }
 *     POST /api/deploy/works/:id/domains/bad_domain/verify (INVALID format)
 *        → 400 { status:'error', message:'Invalid domain format...' }  (controller guard FIRST)
 *     GATE ORDER (probed): format(remove/verify) runs BEFORE ownership — a STRANGER
 *        hitting an INVALID domain on a foreign work gets 400 'Invalid domain format'
 *        (NOT 403); a VALID domain on the same foreign work gets the ownership 403.
 *     OWNERSHIP cross-product (each of remove / verify / add, with a VALID domain):
 *        foreign-owned work → 403 { status:'error', message:'You do not have permission to access this work' }
 *        ghost work id      → 404 { status:'error', message:"Work with id '...' not found" }
 *        anonymous          → 401 { message:'Unauthorized', statusCode:401 }
 *     ParseUUIDPipe: a non-uuid :id → 400 { message:'Validation failed (uuid is expected)', error:'Bad Request' }
 *     METHOD map: PUT /works/:id/domains → 404 'Cannot PUT ...' (only GET+POST are mapped on the list path)
 *
 * ADAPTIVITY (CI reality): NO real Vercel/k8s token is wired and no website is
 * ever published in CI, so the website gate is ALWAYS reached for a valid,
 * owned request — these flows assert the truthful refusal/format/ownership
 * contracts and NEVER trigger a real external domain mutation. Assertions widen
 * with status-sets / .or() (+ trailing .first() on single-element matches) so a
 * pre-configured or website-published stack still passes. Anonymous contexts use
 * an EMPTY storageState so they never inherit the shared auth cookie.
 *
 * NON-DUPLICATION: flow-plugin-deployment.spec.ts test 5 already pins the
 * website-gated "No deployment exists" copy on GET list / POST add / POST verify
 * + a single GET-list cross-user 403/404 + a GET-list anon guard. THIS file does
 * NOT re-assert that copy in isolation; it pins the genuinely-uncovered residue:
 * (1) the DELETE remove verb entirely (website-gated AND format-gated), (2) the
 * controller-level `DOMAIN_RE` format guard on remove/verify and its ORDERING
 * relative to ownership (format-beats-ownership — a stranger+bad-domain is a
 * format-400, not a 403), (3) the AddDomainDto body-validation envelope shape
 * (array message) + missing-domain + forbidNonWhitelisted, distinct from the
 * controller-level remove/verify envelope, (4) the FULL ownership cross-product
 * (403/404/401) applied to remove AND verify AND add (the sibling only did GET
 * list), (5) ParseUUIDPipe + bad-method 404, (6) a nothing-persisted invariant.
 * flow-deploy-capability-contract / flow-deploy-works-teams-deep cover the
 * provider-facade SHAPE, the /teams + /check per-verb request asymmetries, and
 * the deploy-verb gate — none of them touch the domain verbs.
 *
 * ISOLATION: every API mutation runs on a FRESH registerUserViaAPI() user. Unique
 * names/slugs come from a per-test counter (NOT a module-scope clock).
 */

const DEPLOY_BASE = `${API_BASE}/api/deploy`;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const VALID_DOMAIN = 'e2e-dd.example.com';
const INVALID_DOMAIN = 'not_a_domain';

/** Per-test unique-suffix counter (NOT a module-scope clock). */
let seq = 0;
function uniq(prefix: string): string {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

interface WorkRow {
    id: string;
    slug?: string;
    deployProvider?: string | null;
    deploymentState?: string | null;
    website?: string | null;
    deployProjectId?: string | null;
}

/** Create a fresh work (description REQUIRED by the create DTO) and return its row. */
async function freshWork(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<WorkRow> {
    const stamp = uniq('deploy-dd');
    const res = await request.post(`${API_BASE}/api/works`, {
        headers: authedHeaders(token),
        data: {
            name: `Deploy Domains ${stamp}`,
            slug: stamp,
            description: 'flow-deploy-domains-check-deep e2e work',
            organization: false,
            ...overrides,
        },
    });
    expect(res.status(), `work create body=${await res.text().catch(() => '')}`).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const w = (json.work ?? json) as WorkRow;
    expect(w.id, 'created work has an id').toBeTruthy();
    return w;
}

/** Read a work row back (to assert the nothing-persisted invariant). */
async function readWork(request: APIRequestContext, token: string, id: string): Promise<WorkRow> {
    const res = await request.get(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
    });
    expect([200, 201]).toContain(res.status());
    const json = (await res.json()) as Record<string, unknown>;
    return (json.work ?? json) as WorkRow;
}

test.describe('Deploy domains + check — gate-ordering, dual error envelopes, ownership cross-product (deep integration)', () => {
    test('1. GET /works/:id/domains is website-gated: an owned-but-undeployed work (no website published) refuses the domain LIST with the "No deployment exists" copy — never a 5xx, never an empty success leak', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);
        expect(work.website ?? null, 'a fresh work has no published website').toBeNull();

        const res = await request.get(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(access_token),
        });
        // CI reality: no website is ever published -> the website gate always fires.
        // A pre-published stack could 2xx with a domains array — tolerate both, never 5xx.
        expect([200, 201, 400], `domains list status ${res.status()}`).toContain(res.status());
        const body = (await res.json()) as Record<string, unknown>;
        if (res.status() === 400) {
            expect(body.status).toBe('error');
            expect(String(body.message)).toMatch(/No deployment exists/i);
        } else {
            expect(body.status).toBe('success');
            expect(Array.isArray(body.domains), 'a published-website list is an array').toBe(true);
        }
    });

    test('2. POST /works/:id/domains add is website-gated for a VALID domain (owned + no website -> "No deployment exists"), and the refusal writes NOTHING to the work (no website, no project id)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        const res = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(access_token),
            data: { domain: VALID_DOMAIN },
        });
        expect([200, 201, 400], `add-domain status ${res.status()}`).toContain(res.status());
        if (res.status() === 400) {
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.status).toBe('error');
            expect(String(body.message)).toMatch(/No deployment exists/i);
        }

        // INVARIANT: a refused add mutates nothing on the work record.
        const after = await readWork(request, access_token, work.id);
        expect(after.website ?? null, 'refused add did not publish a website').toBeNull();
        expect(after.deployProjectId ?? null, 'refused add did not cache a project id').toBeNull();
    });

    test('3. DELETE /works/:id/domains/:domain (the remove verb — uncovered by siblings) is website-gated for a VALID domain: an owned-but-undeployed work refuses removal with "No deployment exists", and nothing persists', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        const res = await request.delete(
            `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}`,
            {
                headers: authedHeaders(access_token),
            },
        );
        expect([200, 201, 400], `remove-domain status ${res.status()}`).toContain(res.status());
        if (res.status() === 400) {
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.status).toBe('error');
            // A VALID domain passes the format guard, so the refusal is the website gate.
            expect(String(body.message)).toMatch(/No deployment exists/i);
            expect(String(body.message), 'a valid domain is NOT a format rejection').not.toMatch(
                /Invalid domain format/i,
            );
        }

        const after = await readWork(request, access_token, work.id);
        expect(after.website ?? null).toBeNull();
    });

    test('4. POST /works/:id/domains/:domain/verify is website-gated for a VALID domain: owned + undeployed -> "No deployment exists" (the verify verb reaches the same website gate as list/add/remove once the format guard passes)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        const res = await request.post(
            `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}/verify`,
            { headers: authedHeaders(access_token), data: {} },
        );
        expect([200, 201, 400], `verify-domain status ${res.status()}`).toContain(res.status());
        if (res.status() === 400) {
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.status).toBe('error');
            expect(String(body.message)).toMatch(/No deployment exists/i);
            expect(String(body.message)).not.toMatch(/Invalid domain format/i);
        }
    });

    test('5. the controller-level DOMAIN_RE format guard on DELETE/verify fires BEFORE the website gate: an INVALID domain on an OWNED work returns the controller envelope { status:"error", message:"Invalid domain format..." } — distinct from the "No deployment exists" website refusal', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // DELETE with a malformed path param -> the format guard short-circuits with
        // the controller's `{ status:'error' }` envelope, NEVER the website-gate copy.
        const del = await request.delete(
            `${DEPLOY_BASE}/works/${work.id}/domains/${INVALID_DOMAIN}`,
            { headers: authedHeaders(access_token) },
        );
        expect(del.status(), 'invalid-domain DELETE is a format-400').toBe(400);
        const delBody = (await del.json()) as Record<string, unknown>;
        expect(delBody.status, 'controller-level guard uses the status:error envelope').toBe(
            'error',
        );
        expect(String(delBody.message)).toMatch(/Invalid domain format/i);
        expect(String(delBody.message), 'the format guard pre-empts the website gate').not.toMatch(
            /No deployment exists/i,
        );

        // verify with a malformed path param -> identical controller format guard.
        const ver = await request.post(
            `${DEPLOY_BASE}/works/${work.id}/domains/${INVALID_DOMAIN}/verify`,
            { headers: authedHeaders(access_token), data: {} },
        );
        expect(ver.status(), 'invalid-domain verify is a format-400').toBe(400);
        const verBody = (await ver.json()) as Record<string, unknown>;
        expect(verBody.status).toBe('error');
        expect(String(verBody.message)).toMatch(/Invalid domain format/i);
        expect(String(verBody.message)).not.toMatch(/No deployment exists/i);
    });

    test('6. the POST add body uses AddDomainDto (a DIFFERENT validation layer than remove/verify): an invalid `domain` -> the global ValidationPipe array-message envelope { message:[...], error:"Bad Request", statusCode:400 } (NOT the controller `status:error` shape), and a MISSING domain trips the not-empty + must-be-string validators too', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // Invalid `domain` value -> @Matches fails at the DTO layer (array message envelope).
        const bad = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(access_token),
            data: { domain: 'not a domain' },
        });
        expect(bad.status(), 'invalid add-domain body is a DTO-400').toBe(400);
        const badBody = (await bad.json()) as Record<string, unknown>;
        // The DTO/global-pipe envelope is shaped differently from the controller guard:
        // an array `message`, a top-level `error:'Bad Request'`, and `statusCode`.
        expect(Array.isArray(badBody.message), 'DTO validation yields an array message').toBe(true);
        expect(badBody.error).toBe('Bad Request');
        expect(badBody.statusCode).toBe(400);
        expect(JSON.stringify(badBody.message)).toMatch(/Invalid domain format/i);

        // MISSING domain -> @IsNotEmpty + @IsString fire in addition to @Matches.
        const missing = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(missing.status(), 'missing add-domain body is a DTO-400').toBe(400);
        const missingBody = (await missing.json()) as Record<string, unknown>;
        const missingMsg = JSON.stringify(missingBody.message);
        expect(missingMsg).toMatch(/should not be empty|must be a string|Invalid domain format/i);
    });

    test('7. the POST add body enforces forbidNonWhitelisted: a valid `domain` plus an UNKNOWN key -> 400 "property <k> should not exist" (the body-DTO whitelist rejects extras before any ownership/website gate)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        const res = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(access_token),
            data: { domain: VALID_DOMAIN, totallyBogusKey: 1 },
        });
        expect(res.status(), 'an unknown add-domain key is whitelisted out').toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(JSON.stringify(body.message)).toMatch(/should not exist/i);
    });

    test('8. GATE ORDERING — the DOMAIN_RE format guard on DELETE/verify runs BEFORE ownership: a STRANGER hitting an INVALID domain on a FOREIGN work gets the format-400 (not the ownership-403), but the SAME stranger with a VALID domain gets the ownership-403 — proving the precise guard order', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // INVALID domain + foreign caller -> the format guard wins (400), NOT a 403.
        const badForeignDel = await request.delete(
            `${DEPLOY_BASE}/works/${work.id}/domains/${INVALID_DOMAIN}`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(
            badForeignDel.status(),
            'format guard pre-empts ownership for a malformed domain',
        ).toBe(400);
        const badForeignBody = (await badForeignDel.json()) as Record<string, unknown>;
        expect(String(badForeignBody.message)).toMatch(/Invalid domain format/i);
        expect(
            String(badForeignBody.message),
            'a stranger+bad-domain never sees the ownership copy',
        ).not.toMatch(/do not have permission/i);

        // VALID domain + same foreign caller -> the format guard passes, ownership now refuses (403).
        const validForeignDel = await request.delete(
            `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(validForeignDel.status(), 'a valid domain reaches the ownership gate').toBe(403);
        expect(String(((await validForeignDel.json()) as Record<string, unknown>).message)).toMatch(
            /do not have permission/i,
        );

        // verify mirrors the same ordering.
        const badForeignVer = await request.post(
            `${DEPLOY_BASE}/works/${work.id}/domains/${INVALID_DOMAIN}/verify`,
            { headers: authedHeaders(stranger.access_token), data: {} },
        );
        expect(badForeignVer.status(), 'verify format guard also pre-empts ownership').toBe(400);
        expect(String(((await badForeignVer.json()) as Record<string, unknown>).message)).toMatch(
            /Invalid domain format/i,
        );
    });

    test('9. OWNERSHIP cross-product on POST add (VALID domain): foreign-owned -> 403 "do not have permission" (never a leak, never the website 400), ghost id -> 404 "not found", anonymous -> 401 — add is ownership-guarded before the website gate', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // FOREIGN -> 403 (ownership runs before the website gate — never "No deployment exists").
        const foreign = await request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(stranger.access_token),
            data: { domain: VALID_DOMAIN },
        });
        expect(foreign.status(), 'foreign add is ownership-403').toBe(403);
        const foreignBody = (await foreign.json()) as Record<string, unknown>;
        expect(String(foreignBody.message)).toMatch(/do not have permission/i);
        expect(String(foreignBody.message)).not.toMatch(/No deployment exists/i);

        // GHOST -> 404.
        const ghost = await request.post(`${DEPLOY_BASE}/works/${NIL_UUID}/domains`, {
            headers: authedHeaders(owner.access_token),
            data: { domain: VALID_DOMAIN },
        });
        expect(ghost.status(), 'ghost add is 404').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        // ANONYMOUS (empty storageState so the shared auth cookie is NOT inherited) -> 401.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(`${DEPLOY_BASE}/works/${work.id}/domains`, {
                data: { domain: VALID_DOMAIN },
            });
            expect(anonRes.status(), 'anonymous add is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('10. OWNERSHIP cross-product on DELETE remove (VALID domain): foreign-owned -> 403, ghost -> 404, anonymous -> 401 — the remove verb is guarded the SAME way as add, after the format guard passes', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        const foreign = await request.delete(
            `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}`,
            { headers: authedHeaders(stranger.access_token) },
        );
        expect(foreign.status(), 'foreign remove is ownership-403').toBe(403);
        expect(String(((await foreign.json()) as Record<string, unknown>).message)).toMatch(
            /do not have permission/i,
        );

        const ghost = await request.delete(
            `${DEPLOY_BASE}/works/${NIL_UUID}/domains/${VALID_DOMAIN}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(ghost.status(), 'ghost remove is 404').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.delete(
                `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}`,
            );
            expect(anonRes.status(), 'anonymous remove is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('11. OWNERSHIP cross-product on POST verify (VALID domain): foreign-owned -> 403, ghost -> 404, anonymous -> 401 — verify shares the exact ownership matrix of add/remove', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        const foreign = await request.post(
            `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}/verify`,
            { headers: authedHeaders(stranger.access_token), data: {} },
        );
        expect(foreign.status(), 'foreign verify is ownership-403').toBe(403);
        expect(String(((await foreign.json()) as Record<string, unknown>).message)).toMatch(
            /do not have permission/i,
        );

        const ghost = await request.post(
            `${DEPLOY_BASE}/works/${NIL_UUID}/domains/${VALID_DOMAIN}/verify`,
            { headers: authedHeaders(owner.access_token), data: {} },
        );
        expect(ghost.status(), 'ghost verify is 404').toBe(404);
        expect(String(((await ghost.json()) as Record<string, unknown>).message)).toMatch(
            /not found/i,
        );

        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.post(
                `${DEPLOY_BASE}/works/${work.id}/domains/${VALID_DOMAIN}/verify`,
                { data: {} },
            );
            expect(anonRes.status(), 'anonymous verify is auth-guarded').toBe(401);
        } finally {
            await anon.close();
        }
    });

    test('12. the GET list domain verb is ownership-guarded too (mirrors add/remove/verify): foreign-owned -> 403/404, anonymous -> 401 — a foreign caller never leaks the domain list', async ({
        request,
        browser,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await freshWork(request, owner.access_token);

        // FOREIGN list -> ownership refusal (403 for a real foreign work). Some stacks
        // surface 404 to avoid existence-leaks — accept either, but NEVER a 2xx leak.
        const foreign = await request.get(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(
            [403, 404],
            `foreign list status (body=${await foreign.text().catch(() => '')})`,
        ).toContain(foreign.status());
        const foreignBody = (await foreign.json()) as Record<string, unknown>;
        expect(
            foreignBody.domains,
            'a refused list never carries the domains payload',
        ).toBeUndefined();

        // ANONYMOUS -> guarded.
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.get(`${DEPLOY_BASE}/works/${work.id}/domains`);
            expect([401, 403], 'anonymous list is auth-guarded').toContain(anonRes.status());
        } finally {
            await anon.close();
        }
    });

    test('13. the :id param is ParseUUIDPipe-guarded across the domain verbs: a non-uuid work id -> 400 "Validation failed (uuid is expected)" (a malformed id never reaches ownership/website logic)', async ({
        request,
    }) => {
        const { access_token } = await registerUserViaAPI(request);

        // GET list with a non-uuid id.
        const list = await request.get(`${DEPLOY_BASE}/works/not-a-uuid/domains`, {
            headers: authedHeaders(access_token),
        });
        expect(list.status(), 'non-uuid id on the list verb is a ParseUUID-400').toBe(400);
        const listBody = (await list.json()) as Record<string, unknown>;
        expect(String(listBody.message)).toMatch(/uuid is expected/i);

        // POST add with a non-uuid id (a VALID domain so the ParseUUIDPipe is the only failure).
        const add = await request.post(`${DEPLOY_BASE}/works/not-a-uuid/domains`, {
            headers: authedHeaders(access_token),
            data: { domain: VALID_DOMAIN },
        });
        expect(add.status(), 'non-uuid id on the add verb is a ParseUUID-400').toBe(400);
        expect(String(((await add.json()) as Record<string, unknown>).message)).toMatch(
            /uuid is expected/i,
        );
    });

    test('14. the domain LIST path only maps GET + POST: an unmapped method (PUT) on /works/:id/domains -> 404 "Cannot PUT ..." (no accidental verb aliasing), and anonymous calls are auth-guarded on the list verb', async ({
        request,
        browser,
    }) => {
        const { access_token } = await registerUserViaAPI(request);
        const work = await freshWork(request, access_token);

        // PUT is not mapped on the list path -> the router reports an unmatched route.
        const put = await request.fetch(`${DEPLOY_BASE}/works/${work.id}/domains`, {
            method: 'PUT',
            headers: authedHeaders(access_token),
            data: {},
        });
        expect(put.status(), 'PUT is unmapped on the domains list path').toBe(404);
        expect(String(((await put.json()) as Record<string, unknown>).message)).toMatch(
            /Cannot PUT/i,
        );

        // Anonymous GET on the list verb is auth-guarded (empty storageState).
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const anonRes = await anon.request.get(`${DEPLOY_BASE}/works/${work.id}/domains`);
            expect([401, 403], 'anonymous list is auth-guarded').toContain(anonRes.status());
        } finally {
            await anon.close();
        }
    });
});
