import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

/**
 * flow-org-register-company-deep — the genuinely-UNCOVERED edges of the
 * Organization register-company + PATCH-update surface (apps/api/src/
 * organizations/organizations.controller.ts + dto/{register-company,
 * update-organization}.dto.ts).
 *
 * The org area is already DEEP-covered; this file deliberately does NOT
 * restate what the siblings pin. It only adds the gaps they leave open,
 * all PROBED live against the sqlite CI driver on 2026-06-12 (curl
 * http://127.0.0.1:3100) BEFORE any assertion below was written.
 *
 * ── NON-DUPLICATION (specs read first, contracts NOT re-asserted here):
 *   - flow-org-lifecycle-deep.spec.ts → POST create, list, check-slug
 *     basics, get-by-slug global resolver, first-org tenantId backfill,
 *     cross-user list isolation.
 *   - flow-org-slug-lifecycle.spec.ts → slug collision cascade -2/-3/-4,
 *     check-slug value= param (missing/empty/too-long/wrong-param/chars),
 *     the exact normalizer, GLOBAL namespace across users, get-by-slug
 *     anon-401 / unknown-404, PATCH displayName + stray-`slug` 400,
 *     PATCH no-tenant-401 / cross-tenant-404.
 *   - flow-org-upgrade-from-account.spec.ts → register-company
 *     name/legalName-default/countryCode-uppercase/whitelist/bearer/
 *     tenant-mint + tenantId-backfill, and the WHOLE upgrade-from-account
 *     error surface (409/404/400/401/sqlite-500).
 *
 * ── THE GAPS THIS FILE PINS (each PROBED live, none of the above touch it):
 *
 *  register-company:
 *   (A) The endpoint lands a REAL backing Work that is READABLE via
 *       GET /api/works/:id with kind:'company', status:'registered',
 *       organization:false, tenantId == the org's tenant, organizationId:null.
 *       The Work's slug is allocated SEPARATELY from the org slug (it gets its
 *       OWN random suffix, e.g. '<base>-mqa446qi'), and org.linkedWorkId
 *       round-trips through GET /api/organizations/:slug. Siblings assert
 *       linkedWorkId is "a uuid" but never DEREFERENCE the Work.
 *   (B) register-company honours an EXPLICIT `slug` override (RegisterCompanyDto
 *       has @Length(1,64) slug) — siblings only ever exercise the derived slug.
 *       A second register-company with the same explicit slug cascades to -2
 *       (shared allocator), and slug length 65 → 400.
 *
 *  PATCH /api/organizations/:id { displayName?, legalName?, countryCode? }:
 *   (C) legalName + countryCode actually PERSIST (siblings only PATCH
 *       displayName). CRITICAL CONTRAST: PATCH stores countryCode VERBATIM —
 *       'de' stays 'de', 'FR' stays 'FR' — it is NOT uppercased the way
 *       register-company uppercases its countryCode ('us' → 'US'). Probed both
 *       directions.
 *   (D) PATCH validation boundaries (UpdateOrganizationDto = @Length on all 3):
 *         displayName ''            → 400 ("longer than or equal to 1")
 *         displayName 201 chars     → 400
 *         displayName 123 (number)  → 400 ("must be a string")
 *         stray `name` key          → 400 ("property name should not exist")
 *         countryCode 'd' (1 char)  → 400 ("longer than or equal to 2")  ← note
 *           the MESSAGE differs from register-company's "alpha-2" matcher.
 *         non-uuid :id              → 400 ParseUUIDPipe ("uuid is expected")
 *         empty body {}             → 200 no-op (documented contract).
 *   (E) PATCHing a register-company (registered) org changes ONLY the 3
 *       whitelisted fields and leaves registrationStatus/registrationProvider/
 *       linkedWorkId intact — PATCH cannot "downgrade" a registered Company.
 *
 * Cross-spec isolation: every test runs on a FRESH registerUserViaAPI() user
 * with a per-test-title suffix (NOT a module-scope clock); the seeded
 * storageState user is never touched. Fully API-orchestrated + `flow-`
 * filename ⇒ safe vs the playwright.config testIgnore regex and contends on no
 * shared UI state.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-test unique suffix derived from the test title (no module-scope clock). */
function suffix(title: string): string {
    const slugTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return `${slugTitle}-${Math.random().toString(36).slice(2, 8)}`;
}

/** POST /api/organizations/register-company (raw — caller inspects status). */
function registerCompanyRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/organizations/register-company`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** PATCH /api/organizations/:id (raw — caller inspects status). */
function patchOrgRaw(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/organizations/${id}`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** GET /api/organizations/:slug (global resolver). */
function getOrgBySlug(request: APIRequestContext, token: string, slug: string) {
    return request.get(`${API_BASE}/api/organizations/${slug}`, {
        headers: authedHeaders(token),
    });
}

test.describe('register-company — backing Work + explicit slug override (uncovered)', () => {
    test('register-company lands a readable backing company Work (kind/status/scope) with its own slug; linkedWorkId round-trips', async ({
        request,
    }) => {
        const s = suffix('work-link');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const companyName = `WorkLink Co ${s}`;
        const res = await registerCompanyRaw(request, token, { name: companyName });
        expect(res.status(), `register-company body=${await res.text().catch(() => '')}`).toBe(201);
        const org = await res.json();
        expect(org.registrationStatus).toBe('registered');
        expect(org.linkedWorkId, 'register-company links a backing Work').toMatch(UUID_RE);

        // GAP (A): the linked Work is a REAL, dereferenceable row. GET /api/works/:id
        // returns the standard { status:'success', work:{…} } envelope (200, not 201).
        const workRes = await request.get(`${API_BASE}/api/works/${org.linkedWorkId}`, {
            headers: authedHeaders(token),
        });
        expect(workRes.status(), `get work body=${await workRes.text().catch(() => '')}`).toBe(200);
        const workBody = await workRes.json();
        expect(workBody.status).toBe('success');
        const work = workBody.work;

        // The backing Work is the canonical "Company" record: kind:'company',
        // driven through to status:'registered', and NOT an org-template work.
        expect(work.id).toBe(org.linkedWorkId);
        expect(work.kind).toBe('company');
        expect(work.status).toBe('registered');
        expect(work.organization).toBe(false);
        expect(work.companyName).toBe(companyName);

        // The Work shares the org's tenant but is NOT yet pulled INTO the org
        // (organizationId stays null — that is a separate upgrade step).
        expect(work.tenantId).toBe(org.tenantId);
        expect(work.organizationId).toBeNull();

        // The Work's slug is allocated INDEPENDENTLY of the org slug — it carries
        // its own extra suffix, so it starts with the org slug but is NOT equal.
        expect(typeof work.slug).toBe('string');
        expect(work.slug.startsWith(org.slug)).toBe(true);
        expect(work.slug).not.toBe(org.slug);

        // linkedWorkId round-trips through the global slug resolver (the metadata
        // is persisted on the org, not just echoed by the create response).
        const bySlug = await getOrgBySlug(request, token, org.slug);
        expect(bySlug.status()).toBe(200);
        const resolved = await bySlug.json();
        expect(resolved.linkedWorkId).toBe(org.linkedWorkId);
        expect(resolved.registrationStatus).toBe('registered');
        expect(resolved.registrationProvider).toBe('manual');
    });

    test('register-company honours an explicit slug override, cascades -2 on collision, and 400s a too-long slug', async ({
        request,
    }) => {
        const s = suffix('slug-override');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // GAP (B): the explicit `slug` is taken VERBATIM (not re-derived from name).
        const wantSlug = `rc-ovr-${s}`;
        const first = await registerCompanyRaw(request, token, {
            name: 'Totally Different Name',
            slug: wantSlug,
        });
        expect(first.status(), `override body=${await first.text().catch(() => '')}`).toBe(201);
        const firstOrg = await first.json();
        expect(firstOrg.slug, 'explicit slug wins over the derived one').toBe(wantSlug);
        // The org is resolvable at exactly that slug.
        expect((await (await getOrgBySlug(request, token, wantSlug)).json()).id).toBe(firstOrg.id);

        // A SECOND register-company with the SAME explicit slug must NOT 400 — it
        // cascades through the shared allocator to -2 (same behaviour as POST create).
        const second = await registerCompanyRaw(request, token, {
            name: 'Another Name',
            slug: wantSlug,
        });
        expect(second.status()).toBe(201);
        expect((await second.json()).slug).toBe(`${wantSlug}-2`);

        // A slug over the DTO's @Length(1,64) ceiling is a 400 (validated before
        // the allocator runs).
        const tooLong = await registerCompanyRaw(request, token, {
            name: 'Long Slug Co',
            slug: 'a'.repeat(65),
        });
        expect(tooLong.status()).toBe(400);
        expect(JSON.stringify((await tooLong.json()).message)).toMatch(/slug|64|shorter/i);
    });
});

test.describe('PATCH /api/organizations/:id — legalName/countryCode persistence + validation (uncovered)', () => {
    test('PATCH persists legalName + countryCode, and stores countryCode VERBATIM (NOT uppercased like register-company)', async ({
        request,
    }) => {
        const s = suffix('patch-persist');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A plain draft org starts with legalName:null, countryCode:null.
        const org = await createOrganizationViaAPI(request, token, `Patch Persist ${s}`);
        expect(org.id).toMatch(UUID_RE);
        expect((org as { legalName?: string | null }).legalName ?? null).toBeNull();
        expect((org as { countryCode?: string | null }).countryCode ?? null).toBeNull();

        // GAP (C): legalName + countryCode PATCH through and persist.
        const patchRes = await patchOrgRaw(request, token, org.id, {
            legalName: `Patch Persist LLC ${s}`,
            countryCode: 'de',
        });
        expect(patchRes.status(), `patch body=${await patchRes.text().catch(() => '')}`).toBe(200);
        const patched = await patchRes.json();
        expect(patched.legalName).toBe(`Patch Persist LLC ${s}`);
        // CRITICAL CONTRAST: PATCH does NOT case-normalize countryCode the way
        // register-company does. Lowercase 'de' is stored VERBATIM as 'de'.
        expect(patched.countryCode, 'PATCH stores countryCode as-given (lowercase)').toBe('de');
        // The slug + tenant are untouched by a metadata PATCH.
        expect(patched.slug).toBe(org.slug);
        expect(patched.tenantId).toBe(org.tenantId);

        // Uppercase is likewise stored verbatim (round-trips through get-by-slug).
        const upperRes = await patchOrgRaw(request, token, org.id, { countryCode: 'FR' });
        expect(upperRes.status()).toBe(200);
        expect((await upperRes.json()).countryCode).toBe('FR');
        const resolved = await (await getOrgBySlug(request, token, org.slug)).json();
        expect(resolved.countryCode, 'persisted verbatim, not normalized').toBe('FR');
        // legalName from the first PATCH is still present (partial updates merge).
        expect(resolved.legalName).toBe(`Patch Persist LLC ${s}`);
    });

    test('PATCH validation: empty/over-length/non-string displayName, 1-char countryCode, stray key, non-uuid id all 400', async ({
        request,
    }) => {
        const s = suffix('patch-validation');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const org = await createOrganizationViaAPI(request, token, `Patch Valid ${s}`);

        // GAP (D): displayName '' violates @Length(1,200) → 400.
        const empty = await patchOrgRaw(request, token, org.id, { displayName: '' });
        expect(empty.status()).toBe(400);
        expect(JSON.stringify((await empty.json()).message)).toMatch(/longer than or equal to 1/i);

        // displayName 201 chars → 400 (upper bound).
        const tooLong = await patchOrgRaw(request, token, org.id, { displayName: 'x'.repeat(201) });
        expect(tooLong.status()).toBe(400);

        // displayName as a number → @IsString fails → 400.
        const notString = await patchOrgRaw(request, token, org.id, { displayName: 123 });
        expect(notString.status()).toBe(400);
        expect(JSON.stringify((await notString.json()).message)).toMatch(/must be a string/i);

        // countryCode 1 char → @Length(2,2) → 400 with the LENGTH message (this is
        // the contract divergence vs register-company's @Matches alpha-2 message).
        const shortCc = await patchOrgRaw(request, token, org.id, { countryCode: 'd' });
        expect(shortCc.status()).toBe(400);
        expect(JSON.stringify((await shortCc.json()).message)).toMatch(
            /longer than or equal to 2|2 characters/i,
        );

        // Stray non-whitelisted key (`name` is on CREATE, not UPDATE) → 400.
        const stray = await patchOrgRaw(request, token, org.id, {
            name: 'Renamed Via Wrong Field',
        });
        expect(stray.status()).toBe(400);
        expect(JSON.stringify((await stray.json()).message)).toMatch(
            /property name should not exist/i,
        );

        // Non-uuid :id → ParseUUIDPipe 400 BEFORE any service logic (parallels the
        // upgrade-from-account non-uuid case, but on the PATCH route).
        const badId = await request.patch(`${API_BASE}/api/organizations/not-a-uuid`, {
            headers: authedHeaders(token),
            data: { displayName: 'X' },
        });
        expect(badId.status()).toBe(400);
        expect(JSON.stringify((await badId.json()).message)).toMatch(/uuid is expected/i);

        // None of the rejected PATCHes mutated the org (displayName unchanged).
        const after = await (await getOrgBySlug(request, token, org.slug)).json();
        expect(after.displayName).toBe(`Patch Valid ${s}`);
    });

    test('PATCH with an empty body {} is a 200 no-op (documented contract)', async ({
        request,
    }) => {
        const s = suffix('patch-noop');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const org = await createOrganizationViaAPI(request, token, `Patch Noop ${s}`);

        // GAP (D): every UpdateOrganizationDto field is optional, so {} validates
        // and is an explicit no-op — 200 echoing the unchanged org.
        const res = await patchOrgRaw(request, token, org.id, {});
        expect(res.status(), `noop patch body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(org.id);
        expect(body.displayName).toBe(`Patch Noop ${s}`);
        expect(body.slug).toBe(org.slug);
        expect(body.registrationStatus).toBe('draft');
    });

    test('PATCH on a register-company (registered) org changes only the 3 whitelisted fields; status/provider/linkedWorkId stay registered', async ({
        request,
    }) => {
        const s = suffix('patch-registered');
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // A REGISTERED company org (provider=manual, status=registered, linked Work).
        const rc = await registerCompanyRaw(request, token, { name: `Patch Reg Co ${s}` });
        expect(rc.status()).toBe(201);
        const org = await rc.json();
        expect(org.registrationStatus).toBe('registered');
        expect(org.registrationProvider).toBe('manual');
        expect(org.linkedWorkId).toMatch(UUID_RE);

        // GAP (E): PATCH the user-editable metadata — it must NOT touch the
        // registration metadata (those fields aren't on UpdateOrganizationDto, so
        // PATCH cannot "downgrade" a registered Company to draft).
        const patchRes = await patchOrgRaw(request, token, org.id, {
            displayName: `Renamed Reg ${s}`,
            legalName: `Renamed Reg Legal ${s}`,
            countryCode: 'FR',
        });
        expect(patchRes.status(), `patch body=${await patchRes.text().catch(() => '')}`).toBe(200);
        const patched = await patchRes.json();
        expect(patched.displayName).toBe(`Renamed Reg ${s}`);
        expect(patched.legalName).toBe(`Renamed Reg Legal ${s}`);
        expect(patched.countryCode).toBe('FR');
        // Registration metadata is preserved across the PATCH.
        expect(patched.registrationStatus).toBe('registered');
        expect(patched.registrationProvider).toBe('manual');
        expect(patched.linkedWorkId).toBe(org.linkedWorkId);
        expect(patched.slug).toBe(org.slug);
    });
});
