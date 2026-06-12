import {
    test,
    expect,
    request as pwRequest,
    type APIRequestContext,
    type APIResponse,
} from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { seedOrgKbDoc } from './helpers/kb-fixtures';

/**
 * SEC PIN: ORG SCOPE GUARD — pins the EW-711 Wave A/L cross-tenant
 * contracts around the legacy un-prefixed `/api/organizations/:orgId/...`
 * surface and the Work↔Organization pairing path:
 *
 *  1. `OrganizationOwnershipGuard` on `OrgKbController`
 *     (apps/api/src/works/org-kb.controller.ts → guard at
 *     apps/api/src/organizations/guards/organization-ownership.guard.ts,
 *     delegating to `OrganizationMembershipService.ensureMember/ensureAdmin`).
 *     These routes are NOT scope-prefixed, so `ScopeResolverMiddleware`
 *     yields EMPTY_SCOPE and the global `ScopeOwnershipGuard` passes
 *     trivially — the route-level guard is the ONLY thing authorizing the
 *     attacker-supplied `:orgId`. Existence-leak discipline: a foreign
 *     `:orgId` 404s with the SAME envelope as a nonexistent one — never 403.
 *  2. The inheritable-Work routes (`GET /works/:id/kb/inheritable[/...]`)
 *     whose attacker-controlled `?orgId` is validated against the Work's
 *     REAL `organizationId` (`resolveWorkOrgScope` — "trust the Work, not
 *     the param"), behind the works `ensureCanView` gate.
 *  3. The org-ENROLL guard (EW-711 #27, work-lifecycle.service.ts ~L622):
 *     `PATCH /api/works/:id { organizationId }` resolves the target org and
 *     requires `org.tenantId === work.tenantId`, rejecting cross-tenant
 *     enrollment with an existence-leak-safe 404 (a Work's KB would
 *     otherwise fan into another tenant's org overlay).
 *
 * PROBED CONTRACTS (live API http://127.0.0.1:3100, sqlite in-memory — the
 * CI driver — probed with node-fetch + fresh registered users, 2026-06-11;
 * every assertion below mirrors a probe):
 *   org-KB routes `/api/organizations/:orgId/kb/documents`:
 *     anon / garbage bearer GET+POST → 401 {message:'Unauthorized',statusCode:401}
 *     member GET            → 200 { items:[KbDocumentDto…] } (workId:null,
 *                             organizationId:<orgId>); `?class=legal` filters
 *     member POST           → 201 KbDocumentBodyDto; class outside
 *                             legal|style|seo → 400 "Organization-scoped KB
 *                             documents must have class in [legal, style, seo]…"
 *     cross-tenant GET/POST → 404 {message:'Organization <id> not found',
 *                             error:'Not Found',statusCode:404} — envelope
 *                             byte-identical (modulo echoed id) to a
 *                             NONEXISTENT org id, and nothing is written
 *     cross-tenant POST {}  → 404 NOT 400 (guards run before pipes — the
 *                             validation oracle only exists for members;
 *                             member POST {} → 400 with field messages)
 *     tenant-less caller    → 404 same envelope (fail-closed no-tenant branch)
 *     non-uuid :orgId       → 404 'Organization not-a-uuid not found' (no
 *                             ParseUUIDPipe on this param; guard fail-closes,
 *                             no 500/400)
 *   inheritable routes `/api/works/:id/kb/inheritable[/{class}/{slug}.md]`:
 *     anon                  → 401 (controller-level AuthSessionGuard)
 *     non-member of Work    → 403 {status:'error',message:'You do not have
 *                             permission to access this work'} (ensureCanView
 *                             — both list and body routes)
 *     own Work, foreign ?orgId → 403 {message:'orgId does not match the
 *                             organization of the requested Work',
 *                             error:'Forbidden',statusCode:403} (also when the
 *                             Work has NO org and any orgId is supplied)
 *     own Work, matching or OMITTED ?orgId → 200; org docs resolve from the
 *                             Work's real organizationId (workId:null rows)
 *     no-org Work, omitted orgId → list 200 []; body route 404
 *                             'KB inherited document not found: <path>'
 *   org-enroll `PATCH /api/works/:id { organizationId }`:
 *     cross-tenant target   → 404 {status:'error',message:'Organization not
 *                             found'} — identical envelope for an unknown
 *                             uuid; Work.organizationId unchanged
 *     tenant-less caller    → 404 same envelope (null work.tenantId never
 *                             matches a real org's tenant)
 *     same-tenant target    → 200 {status:'success',work:{organizationId:<id>}};
 *                             organizationId:null clears the pairing
 *     foreign WORK          → 403 works-guard (ownership precedes org check)
 *   setup facts: POST /api/organizations {name} → 201 {id,tenantId,…} and
 *     mints the user's Tenant on first org; a Work created AFTER the org is
 *     auto-paired (organizationId pre-set), one created BEFORE has
 *     organizationId:null — pairing is therefore PATCHed explicitly below.
 *
 * NON-DUPLICATION: the org/KB e2e family covers SAME-USER flows only —
 * flow-kb-inherited(.spec)/flow-kb-inherited-overrides(-deep)/flow-kb-citations
 * pin the owner's inheritance/override/body resolution with a MATCHING orgId;
 * flow-tenant-isolation-resources pins the WORK-scoped KB cross-user 403;
 * flow-org-member-roles-matrix + flow-multi-tenant-isolation pin org
 * CRUD/list/slug cross-tenant; flow-org-upgrade-from-account pins the
 * upgrade-from-account cross-tenant 404. NONE of them touches the
 * `/api/organizations/:orgId/kb/*` cross-USER matrix, the inheritable
 * foreign-?orgId mismatch 403, or the EW-711 #27 enroll guard (repo-wide
 * grep over apps/web/e2e for 'organizations/.*kb' cross-user usage,
 * 'does not match the organization', and enroll-by-PATCH returned only
 * same-user call sites). This file pins exactly those gaps.
 *
 * ADAPTIVITY: pure REST — no LLM key, no MailHog, no Redis required.
 * Anonymous calls use a fresh empty-storageState request context (the
 * project request fixture inherits the seeded auth cookie). All actors are
 * fresh `registerUserViaAPI` users with timestamped names/slugs.
 */

const ORG_KB = (orgId: string) => `${API_BASE}/api/organizations/${orgId}/kb/documents`;
const INHERITABLE = (workId: string) => `${API_BASE}/api/works/${workId}/kb/inheritable`;

const UNKNOWN_UUID = '11111111-2222-4333-8444-555555555555';

const ANON_401 = { message: 'Unauthorized', statusCode: 401 };
const WORKS_403 = { status: 'error', message: 'You do not have permission to access this work' };
const ORG_MISMATCH_403 = {
    message: 'orgId does not match the organization of the requested Work',
    error: 'Forbidden',
    statusCode: 403,
};
const ENROLL_404 = { status: 'error', message: 'Organization not found' };
const org404 = (orgId: string) => ({
    message: `Organization ${orgId} not found`,
    error: 'Not Found',
    statusCode: 404,
});

interface KbDocRow {
    id: string;
    workId: string | null;
    organizationId: string | null;
    path: string;
    class: string;
}

function stamp(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Fresh request context with NO cookies — genuinely anonymous. */
async function anonContext(): Promise<APIRequestContext> {
    return pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

function inheritableBody(payload: { path?: string } = {}): {
    path: string;
    title: string;
    class: string;
    body: string;
} {
    const s = stamp();
    return {
        path: payload.path ?? `legal/pin-${s}.md`,
        title: `Pin Doc ${s}`,
        class: 'legal',
        body: `# org doc ${s}`,
    };
}

/** PATCH a Work's organizationId pairing; returns the raw response. */
function patchWorkOrg(
    request: APIRequestContext,
    token: string,
    workId: string,
    organizationId: string | null,
): Promise<APIResponse> {
    return request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data: { organizationId },
    });
}

/** Read back a Work's current organizationId via GET /api/works/:id. */
async function getWorkOrgId(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<string | null> {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `GET work ${workId}`).toBe(200);
    const body = (await res.json()) as { work: { organizationId: string | null } };
    return body.work.organizationId;
}

interface Victim {
    token: string;
    orgId: string;
    workId: string;
    docPath: string;
    docId: string;
}

/**
 * Mint the victim tenant: fresh user A + org A + a Work explicitly paired
 * with org A + one inheritable org-scope doc. Pairing is PATCHed explicitly
 * (not left to the create-time auto-pairing) so the fixture doesn't lean on
 * an incidental behaviour.
 */
async function mintVictim(request: APIRequestContext): Promise<Victim> {
    const a = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, a.access_token, `Pin OrgA ${stamp()}`);
    const work = await createWorkViaAPI(request, a.access_token, { name: `Pin WorkA ${stamp()}` });
    const paired = await patchWorkOrg(request, a.access_token, work.id, org.id);
    expect(paired.status(), 'victim work↔org pairing').toBe(200);
    const doc = await seedOrgKbDoc(request, a.access_token, {
        orgId: org.id,
        path: `legal/pin-${stamp()}.md`,
        body: '# victim org-scope doc — must never cross the tenant boundary',
    });
    return {
        token: a.access_token,
        orgId: org.id,
        workId: work.id,
        docPath: doc.path,
        docId: doc.documentId,
    };
}

/** Mint an attacker with their OWN tenant (fresh user B + org B). */
async function mintAttacker(request: APIRequestContext): Promise<{ token: string; orgId: string }> {
    const b = await registerUserViaAPI(request);
    const org = await createOrganizationViaAPI(request, b.access_token, `Pin OrgB ${stamp()}`);
    return { token: b.access_token, orgId: org.id };
}

test.describe('SEC PIN — org-KB OrganizationOwnershipGuard (/api/organizations/:orgId/kb/documents)', () => {
    test('anon + garbage bearer on list AND create → 401 Unauthorized (AuthSessionGuard fires before the ownership guard)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const anon = await anonContext();
        try {
            const hits: Array<{ label: string; res: APIResponse }> = [
                { label: 'anon GET list', res: await anon.get(ORG_KB(victim.orgId)) },
                {
                    label: 'anon POST create',
                    res: await anon.post(ORG_KB(victim.orgId), { data: inheritableBody() }),
                },
                {
                    label: 'garbage-bearer GET list',
                    res: await anon.get(ORG_KB(victim.orgId), {
                        headers: authedHeaders(`garbage-${stamp()}`),
                    }),
                },
            ];
            for (const hit of hits) {
                expect(hit.res.status(), `${hit.label} → 401`).toBe(401);
                expect((await hit.res.json()) as Record<string, unknown>, hit.label).toEqual(
                    ANON_401,
                );
            }
        } finally {
            await anon.dispose();
        }
    });

    test('member (same tenant) list → 200 {items} with the seeded org doc; ?class=legal filter keeps it (positive arm of the matrix)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        for (const url of [ORG_KB(victim.orgId), `${ORG_KB(victim.orgId)}?class=legal`]) {
            const res = await request.get(url, { headers: authedHeaders(victim.token) });
            expect(res.status(), `member GET ${url}`).toBe(200);
            const body = (await res.json()) as { items: KbDocRow[] };
            const row = body.items.find((d) => d.id === victim.docId);
            expect(row, `seeded doc present via ${url}`).toBeTruthy();
            expect(row?.workId, 'org-scope row has workId null').toBeNull();
            expect(row?.organizationId, 'org-scope row carries the orgId').toBe(victim.orgId);
        }
    });

    test('cross-tenant GET → 404 "Organization <id> not found", envelope IDENTICAL to a nonexistent org (no 403 existence leak)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);

        const crossRes = await request.get(ORG_KB(victim.orgId), {
            headers: authedHeaders(attacker.token),
        });
        expect(crossRes.status(), 'cross-tenant GET is a 404, NOT 403').toBe(404);
        const crossBody = (await crossRes.json()) as Record<string, unknown>;
        expect(crossBody).toEqual(org404(victim.orgId));

        // Indistinguishability: the same caller probing a uuid that exists in
        // NO tenant gets the exact same envelope (modulo the echoed id).
        const ghostRes = await request.get(ORG_KB(UNKNOWN_UUID), {
            headers: authedHeaders(attacker.token),
        });
        expect(ghostRes.status(), 'nonexistent org GET').toBe(404);
        expect((await ghostRes.json()) as Record<string, unknown>).toEqual(org404(UNKNOWN_UUID));
    });

    test('cross-tenant POST with a fully VALID inheritable body → 404 and writes nothing (stored-injection / repo-poisoning vector closed)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);
        const evil = inheritableBody({ path: `legal/evil-${stamp()}.md` });

        const res = await request.post(ORG_KB(victim.orgId), {
            headers: authedHeaders(attacker.token),
            data: evil,
        });
        expect(res.status(), 'cross-tenant write → 404 (@OrgAdmin + guard)').toBe(404);
        expect((await res.json()) as Record<string, unknown>).toEqual(org404(victim.orgId));

        // The victim's org doc set is untouched — the attempted path never landed.
        const listRes = await request.get(ORG_KB(victim.orgId), {
            headers: authedHeaders(victim.token),
        });
        expect(listRes.status()).toBe(200);
        const list = (await listRes.json()) as { items: KbDocRow[] };
        expect(
            list.items.map((d) => d.path),
            'attacker path never persisted',
        ).not.toContain(evil.path);
        expect(
            list.items.map((d) => d.id),
            'victim doc still the only seeded row',
        ).toContain(victim.docId);
    });

    test('guard runs BEFORE validation: cross-tenant POST {} → 404 (never 400), while a member POST {} → 400 field errors', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);

        // Foreigner gets NO validation oracle — the ownership guard 404s
        // before the global ValidationPipe ever inspects the body.
        const crossRes = await request.post(ORG_KB(victim.orgId), {
            headers: authedHeaders(attacker.token),
            data: {},
        });
        expect(crossRes.status(), 'cross-tenant empty body → 404, NOT 400').toBe(404);
        expect((await crossRes.json()) as Record<string, unknown>).toEqual(org404(victim.orgId));

        // Member control: the SAME empty body past the guard hits validation.
        const memberRes = await request.post(ORG_KB(victim.orgId), {
            headers: authedHeaders(victim.token),
            data: {},
        });
        expect(memberRes.status(), 'member empty body → 400').toBe(400);
        const memberBody = (await memberRes.json()) as { message: string[]; statusCode: number };
        expect(memberBody.statusCode).toBe(400);
        expect(memberBody.message.join(' | ')).toContain('path must be a string');
        expect(memberBody.message.join(' | ')).toContain('title must be a string');
    });

    test('tenant-less caller (registered, never created an org) → 404 on list AND create (fail-closed no-tenant branch)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const tenantless = await registerUserViaAPI(request); // no org ⇒ no tenant

        const getRes = await request.get(ORG_KB(victim.orgId), {
            headers: authedHeaders(tenantless.access_token),
        });
        expect(getRes.status(), 'tenant-less GET').toBe(404);
        expect((await getRes.json()) as Record<string, unknown>).toEqual(org404(victim.orgId));

        const postRes = await request.post(ORG_KB(victim.orgId), {
            headers: authedHeaders(tenantless.access_token),
            data: inheritableBody(),
        });
        expect(postRes.status(), 'tenant-less POST').toBe(404);
        expect((await postRes.json()) as Record<string, unknown>).toEqual(org404(victim.orgId));
    });

    test('non-uuid :orgId → 404 "Organization not-a-uuid not found" (no ParseUUIDPipe on the param; guard fail-closes without a 500)', async ({
        request,
    }) => {
        const caller = await mintAttacker(request); // has a real tenant — still 404s
        const res = await request.get(ORG_KB('not-a-uuid'), {
            headers: authedHeaders(caller.token),
        });
        expect(res.status(), 'garbage orgId fails closed').toBe(404);
        expect((await res.json()) as Record<string, unknown>).toEqual(org404('not-a-uuid'));
    });
});

test.describe('SEC PIN — inheritable Work routes: trust-the-Work orgId resolution', () => {
    test('non-member hitting a foreign Work: inheritable LIST and inherited BODY → 403 works-guard (Work gate fires before any org resolution)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);

        const listRes = await request.get(`${INHERITABLE(victim.workId)}?orgId=${victim.orgId}`, {
            headers: authedHeaders(attacker.token),
        });
        expect(listRes.status(), 'foreign Work inheritable list').toBe(403);
        expect((await listRes.json()) as Record<string, unknown>).toEqual(WORKS_403);

        const bodyRes = await request.get(
            `${INHERITABLE(victim.workId)}/${victim.docPath}?orgId=${victim.orgId}`,
            { headers: authedHeaders(attacker.token) },
        );
        expect(bodyRes.status(), 'foreign Work inherited body').toBe(403);
        expect((await bodyRes.json()) as Record<string, unknown>).toEqual(WORKS_403);
    });

    test("own Work + FOREIGN ?orgId → 403 mismatch; matching or OMITTED orgId → 200 resolving the Work's REAL org docs", async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);

        // The victim (a fully authorized Work viewer) still cannot point the
        // resolver at someone ELSE's org — the param must match the Work.
        const mismatchRes = await request.get(
            `${INHERITABLE(victim.workId)}?orgId=${attacker.orgId}`,
            { headers: authedHeaders(victim.token) },
        );
        expect(mismatchRes.status(), 'foreign orgId on own Work').toBe(403);
        expect((await mismatchRes.json()) as Record<string, unknown>).toEqual(ORG_MISMATCH_403);

        // Control: matching orgId AND omitted orgId both resolve the doc from
        // the Work's real organizationId (the param adds no authority).
        for (const url of [
            `${INHERITABLE(victim.workId)}?orgId=${victim.orgId}`,
            INHERITABLE(victim.workId),
        ]) {
            const okRes = await request.get(url, { headers: authedHeaders(victim.token) });
            expect(okRes.status(), `inheritable 200 via ${url}`).toBe(200);
            const docs = (await okRes.json()) as KbDocRow[];
            const row = docs.find((d) => d.id === victim.docId);
            expect(row, `org doc resolved via ${url}`).toBeTruthy();
            expect(row?.workId, 'resolved as an ORG row (workId null)').toBeNull();
            expect(row?.organizationId).toBe(victim.orgId);
        }
    });

    test('Work with NO org: any supplied ?orgId → 403 mismatch (list + body); omitted → list [] and body 404 (null scope ⇒ nothing inheritable)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        // Fresh tenant-less user: their Work is born with organizationId null.
        const loner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, loner.access_token, {
            name: `Pin NoOrg Work ${stamp()}`,
        });

        // Smuggling the VICTIM's orgId onto an org-less Work resolves nothing:
        // suppliedOrgId !== null(work org) → 403, on BOTH routes.
        const listRes = await request.get(`${INHERITABLE(work.id)}?orgId=${victim.orgId}`, {
            headers: authedHeaders(loner.access_token),
        });
        expect(listRes.status(), 'foreign orgId on org-less Work (list)').toBe(403);
        expect((await listRes.json()) as Record<string, unknown>).toEqual(ORG_MISMATCH_403);

        const bodyRes = await request.get(
            `${INHERITABLE(work.id)}/${victim.docPath}?orgId=${victim.orgId}`,
            { headers: authedHeaders(loner.access_token) },
        );
        expect(bodyRes.status(), 'foreign orgId on org-less Work (body)').toBe(403);
        expect((await bodyRes.json()) as Record<string, unknown>).toEqual(ORG_MISMATCH_403);

        // Control: with no orgId the null scope yields an empty inheritable
        // set and the body route 404s with its not-found message.
        const emptyRes = await request.get(INHERITABLE(work.id), {
            headers: authedHeaders(loner.access_token),
        });
        expect(emptyRes.status()).toBe(200);
        expect((await emptyRes.json()) as KbDocRow[]).toEqual([]);

        const ghostPath = `legal/nope-${stamp()}.md`;
        const ghostRes = await request.get(`${INHERITABLE(work.id)}/${ghostPath}`, {
            headers: authedHeaders(loner.access_token),
        });
        expect(ghostRes.status(), 'body route on null org scope').toBe(404);
        const ghostBody = (await ghostRes.json()) as { message: string; statusCode: number };
        expect(ghostBody.statusCode).toBe(404);
        expect(ghostBody.message).toBe(`KB inherited document not found: ${ghostPath}`);
    });
});

test.describe('SEC PIN — org-enroll cross-tenant guard (EW-711 #27, PATCH /api/works/:id organizationId)', () => {
    test('enrolling own Work into a FOREIGN org → 404 "Organization not found", indistinguishable from an unknown uuid, and nothing changes', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);
        const work = await createWorkViaAPI(request, attacker.token, {
            name: `Pin Enroll Work ${stamp()}`,
        });
        const orgBefore = await getWorkOrgId(request, attacker.token, work.id);

        // Cross-tenant target org → existence-leak-safe 404.
        const crossRes = await patchWorkOrg(request, attacker.token, work.id, victim.orgId);
        expect(crossRes.status(), 'cross-tenant enroll').toBe(404);
        expect((await crossRes.json()) as Record<string, unknown>).toEqual(ENROLL_404);

        // Unknown uuid target → byte-identical envelope (cannot probe org existence).
        const ghostRes = await patchWorkOrg(request, attacker.token, work.id, UNKNOWN_UUID);
        expect(ghostRes.status(), 'unknown-uuid enroll').toBe(404);
        expect((await ghostRes.json()) as Record<string, unknown>).toEqual(ENROLL_404);

        // The Work's pairing is untouched by either rejected write.
        expect(
            await getWorkOrgId(request, attacker.token, work.id),
            'organizationId unchanged after blocked enrolls',
        ).toBe(orgBefore);

        // Tenant-less caller: work.tenantId is null ⇒ can never match a real
        // org's tenant ⇒ same fail-closed 404.
        const loner = await registerUserViaAPI(request);
        const lonerWork = await createWorkViaAPI(request, loner.access_token, {
            name: `Pin Loner Work ${stamp()}`,
        });
        const lonerRes = await patchWorkOrg(
            request,
            loner.access_token,
            lonerWork.id,
            victim.orgId,
        );
        expect(lonerRes.status(), 'tenant-less enroll into foreign org').toBe(404);
        expect((await lonerRes.json()) as Record<string, unknown>).toEqual(ENROLL_404);
    });

    test('same-tenant enroll → 200 sets organizationId; null clears it; PATCHing a FOREIGN Work → 403 works-guard (ownership precedes org check)', async ({
        request,
    }) => {
        const victim = await mintVictim(request);
        const attacker = await mintAttacker(request);
        const work = await createWorkViaAPI(request, attacker.token, {
            name: `Pin SameTenant Work ${stamp()}`,
        });

        // Positive arm: pairing with the caller's OWN org succeeds.
        const enrollRes = await patchWorkOrg(request, attacker.token, work.id, attacker.orgId);
        expect(enrollRes.status(), 'same-tenant enroll').toBe(200);
        const enrolled = (await enrollRes.json()) as {
            status: string;
            work: { organizationId: string | null };
        };
        expect(enrolled.status).toBe('success');
        expect(enrolled.work.organizationId).toBe(attacker.orgId);

        // organizationId:null is the unguarded clear-membership path.
        const clearRes = await patchWorkOrg(request, attacker.token, work.id, null);
        expect(clearRes.status(), 'clear pairing').toBe(200);
        const cleared = (await clearRes.json()) as { work: { organizationId: string | null } };
        expect(cleared.work.organizationId).toBeNull();

        // A foreign WORK is rejected by the works ownership gate (403), not
        // the org check — and the victim's pairing survives.
        const foreignWorkRes = await patchWorkOrg(
            request,
            attacker.token,
            victim.workId,
            attacker.orgId,
        );
        expect(foreignWorkRes.status(), 'enroll attempt on foreign Work').toBe(403);
        expect((await foreignWorkRes.json()) as Record<string, unknown>).toEqual(WORKS_403);
        expect(
            await getWorkOrgId(request, victim.token, victim.workId),
            "victim Work's pairing untouched",
        ).toBe(victim.orgId);
    });
});
