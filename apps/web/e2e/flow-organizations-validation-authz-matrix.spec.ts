import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

/**
 * flow-organizations-validation-authz-matrix — an EXHAUSTIVE validation +
 * authz MATRIX for the Organization CRUD controller
 * (apps/api/src/organizations/organizations.controller.ts + dto/{create,
 * update,register-company}.dto.ts + organization.service.ts).
 *
 * The org area already has DEEP behavioural coverage; this file deliberately
 * does NOT restate the happy-path CRUD the siblings pin. Its distinct angle is
 * the systematic per-field × per-error-kind grid the prose-style siblings do
 * not enumerate:
 *   - flow-org-lifecycle-deep / flow-org-slug-lifecycle → create/list/check-slug
 *     mechanics, slug collision cascade, the normalizer, global resolver.
 *   - flow-org-settings-persistence / flow-organization-vision-deep → PATCH
 *     display/legal/country/vision persistence + vision timestamp lifecycle.
 *   - flow-org-upgrade-from-account / flow-org-register-company-deep → the
 *     upgrade + register-company happy paths and cross-feature wiring.
 *   - flow-org-member-roles-matrix / flow-org-members-rbac-multistep → org
 *     MEMBER ops (a separate controller; the CRUD controller under test here
 *     exposes NO member routes, so member-op validation lives there, not here).
 *
 * WHAT THIS FILE ADDS (each row PROBED live against http://127.0.0.1:3100,
 * the sqlite in-memory CI driver, on 2026-07-21 BEFORE any assertion below):
 *   • Type-confusion grid — every string DTO field rejects number/boolean/
 *     array/object with 400 (@IsString), not just wrong-length.
 *   • Exact boundary grid — at-limit succeeds, over-by-one 400: name 200 ok /
 *     201 → 400; slug 1 & 64 ok / 65 → 400; vision 5000 ok / 5001 → 400;
 *     countryCode length-2-exact (1 & 3 → 400).
 *   • Two subtle DIVERGENCES between the create paths, asserted side-by-side:
 *       – whitespace-only name: POST /organizations → 409 (service
 *         ConflictException) but POST /organizations/register-company → 400
 *         (controller BadRequestException).
 *       – countryCode: register-company @Matches-validates then UPPERCASES
 *         (de → DE); PATCH stores it verbatim (de stays de).
 *       – create `slug` has NO pattern gate (accepts "Bad Slug!! 99",
 *         normalizes to bad-slug-99) whereas check-slug's `value` @Matches
 *         a strict charset.
 *   • Consolidated table-driven authz matrix (404-never-403) for PATCH and
 *     upgrade-from-account, incl. the no-tenant nuance: a tenant-less caller
 *     gets 401 (PATCH) / 409 (upgrade) BEFORE the resource is looked up, while
 *     a tenant-owning cross-user caller gets 404 (never 403, never a leak).
 *   • Read-isolation contrast: GET /organizations/:slug is NOT tenant-scoped
 *     (any authed user resolves any org by slug → 200) yet GET /organizations
 *     (list) IS tenant-scoped (never contains another tenant's org).
 *
 * VERIFIED CONTRACT (status codes + error shapes pinned below):
 *   POST /api/organizations { name(1..200), slug?(1..64), vision?(≤5000|null) }
 *     201 → { id, tenantId, slug, displayName, legalName, countryCode,
 *             registrationProvider, registrationStatus:'draft', linkedWorkId,
 *             vision, visionUpdatedAt, createdAt, updatedAt }  (NO `name` echoed)
 *     name missing/empty/wrong-type/too-long → 400 (class-validator message[])
 *     name whitespace-only → 409 "Organization name is required"
 *     slug ''/65+/wrong-type → 400 ; slug punctuation → 201 (normalized)
 *     vision 5001/non-string → 400 ; vision null/≤5000 → 201
 *     unknown field → 400 "property X should not exist" (forbidNonWhitelisted)
 *     malformed JSON → 400 ; no bearer → 401
 *   PATCH /api/organizations/:id { displayName?, legalName?, countryCode?, vision? }
 *     displayName null/''/wrong-type/>200 → 400 (NOT-NULL: null is rejected)
 *     legalName null → 200 (nullable clear) ; '' → 400 ; >200 → 400
 *     countryCode 1/3/''/wrong-type → 400 ; 2 → 200 (verbatim) ; null → 200
 *     vision >5000/non-string → 400 ; null → 200
 *     unknown field → 400 ; empty body {} → 200 (no-op) ; malformed uuid → 400
 *     unknown uuid → 404 ; cross-tenant → 404 ; no-tenant caller → 401 ; anon → 401
 *   POST /api/organizations/:id/upgrade-from-account
 *     first-org → 201 { organizationId, tenantId, tierA/B/CRowsUpdated }
 *     after 2nd org → 409 { code:'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS' }
 *     no-tenant caller → 409 ; cross-tenant/unknown → 404 ; malformed → 400 ; anon → 401
 *   POST /api/organizations/register-company { name, legalName?, countryCode?, slug? }
 *     201 → registrationProvider:'manual', registrationStatus:'registered',
 *            linkedWorkId set, countryCode uppercased
 *     whitespace name → 400 ; countryCode not-2-letters → 400
 *
 * Isolation discipline: every test mints FRESH registerUserViaAPI() users +
 * lazily-created orgs. Fully API-orchestrated (`flow-` prefix), so it never
 * contends on the shared UI auth state.
 */

const UUID_UNKNOWN = '99999999-9999-4999-8999-999999999999';
const UUID_MALFORMED = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function orgsUrl(): string {
    return `${API_BASE}/api/organizations`;
}

/** POST /api/organizations with an arbitrary (possibly invalid) JSON body. */
function postOrg(request: APIRequestContext, token: string, data: unknown) {
    return request.post(orgsUrl(), { headers: authedHeaders(token), data: data as object });
}

/** PATCH /api/organizations/:id with an arbitrary body. */
function patchOrg(request: APIRequestContext, token: string, id: string, data: unknown) {
    return request.patch(`${orgsUrl()}/${id}`, {
        headers: authedHeaders(token),
        data: data as object,
    });
}

/** Register a fresh user and return the bearer token + user id. */
async function freshToken(request: APIRequestContext): Promise<{ token: string; userId: string }> {
    const u = await registerUserViaAPI(request);
    return { token: u.access_token, userId: u.user.id };
}

/** Register a fresh user AND give them one org (so they own a Tenant). */
async function freshOwnerWithOrg(request: APIRequestContext) {
    const { token, userId } = await freshToken(request);
    const org = await createOrganizationViaAPI(request, token, `Org ${stamp()}`);
    return { token, userId, org };
}

// ───────────────────────────── CREATE validation ─────────────────────────────

test.describe('POST /api/organizations — create validation matrix', () => {
    test('name is REQUIRED: missing → 400 with class-validator message array', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const res = await postOrg(request, token, {});
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.statusCode).toBe(400);
        expect(Array.isArray(body.message)).toBe(true);
        expect(body.message.join(' ')).toContain('name');
    });

    test('empty-string name → 400; whitespace-only name → 409 (service, not DTO)', async ({
        request,
    }) => {
        const { token } = await freshToken(request);

        const empty = await postOrg(request, token, { name: '' });
        expect(empty.status()).toBe(400);

        // '   ' passes @Length(1,200) (whitespace counts) but the service
        // trims and rejects the empty result with a ConflictException → 409.
        const ws = await postOrg(request, token, { name: '   ' });
        expect(ws.status()).toBe(409);
        const body = await ws.json();
        expect(body.statusCode).toBe(409);
        expect(String(body.message)).toContain('required');
    });

    test('name length boundaries: 1 & 200 succeed, 201 → 400', async ({ request }) => {
        const { token } = await freshToken(request);

        const min = await postOrg(request, token, { name: 'x' });
        expect(min.status()).toBe(201);

        const max = await postOrg(request, token, { name: 'a'.repeat(200) });
        expect(max.status()).toBe(201);

        const over = await postOrg(request, token, { name: 'a'.repeat(201) });
        expect(over.status()).toBe(400);
    });

    test('name type-confusion: number/boolean/array/object all → 400', async ({ request }) => {
        const { token } = await freshToken(request);
        for (const bad of [123, true, ['x'], { x: 1 }]) {
            const res = await postOrg(request, token, { name: bad });
            expect(res.status(), `name=${JSON.stringify(bad)}`).toBe(400);
        }
    });

    test('slug boundaries: 1 & 64 ok, empty & 65 → 400', async ({ request }) => {
        const { token } = await freshToken(request);

        const min = await postOrg(request, token, { name: `S ${stamp()}`, slug: 'q' });
        expect(min.status()).toBe(201);

        const max = await postOrg(request, token, { name: `S ${stamp()}`, slug: 'z'.repeat(64) });
        expect(max.status()).toBe(201);

        const empty = await postOrg(request, token, { name: `S ${stamp()}`, slug: '' });
        expect(empty.status()).toBe(400);

        const over = await postOrg(request, token, { name: `S ${stamp()}`, slug: 'c'.repeat(65) });
        expect(over.status()).toBe(400);
    });

    test('slug type-confusion: number/boolean/array → 400', async ({ request }) => {
        const { token } = await freshToken(request);
        for (const bad of [123, true, ['x']]) {
            const res = await postOrg(request, token, { name: `S ${stamp()}`, slug: bad });
            expect(res.status(), `slug=${JSON.stringify(bad)}`).toBe(400);
        }
    });

    test('create `slug` has NO pattern gate — punctuation/spaces accepted + normalized', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        // Unlike check-slug's `value` (@Matches strict charset), the create DTO
        // slug is length-only; the allocator normalizes it to a URL-safe form.
        const res = await postOrg(request, token, {
            name: `Lenient ${stamp()}`,
            slug: 'Bad Slug!! 99',
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.slug).toMatch(/^bad-slug-99/);
        expect(body.slug).not.toContain(' ');
        expect(body.slug).not.toContain('!');
    });

    test('vision: ≤5000 & null succeed, 5001 → 400, non-string → 400', async ({ request }) => {
        const { token } = await freshToken(request);

        const atMax = await postOrg(request, token, {
            name: `V ${stamp()}`,
            vision: 'x'.repeat(5000),
        });
        expect(atMax.status()).toBe(201);

        const nul = await postOrg(request, token, { name: `V ${stamp()}`, vision: null });
        expect(nul.status()).toBe(201);
        expect((await nul.json()).vision).toBeNull();

        const over = await postOrg(request, token, {
            name: `V ${stamp()}`,
            vision: 'x'.repeat(5001),
        });
        expect(over.status()).toBe(400);
        expect((await over.json()).message.join(' ')).toContain('5000');

        for (const bad of [123, true, ['x']]) {
            const res = await postOrg(request, token, { name: `V ${stamp()}`, vision: bad });
            expect(res.status(), `vision=${JSON.stringify(bad)}`).toBe(400);
        }
    });

    test('non-string vision that DOES survive: valid text is trimmed + stamps visionUpdatedAt', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const res = await postOrg(request, token, { name: `V ${stamp()}`, vision: '  Build it  ' });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.vision).toBe('Build it');
        expect(typeof body.visionUpdatedAt).toBe('string');
    });

    test('unknown field → 400 forbidNonWhitelisted; malformed JSON → 400', async ({ request }) => {
        const { token } = await freshToken(request);

        const extra = await postOrg(request, token, { name: `X ${stamp()}`, bogusField: 'x' });
        expect(extra.status()).toBe(400);
        expect((await extra.json()).message.join(' ')).toContain('bogusField');

        const badJson = await request.post(orgsUrl(), {
            headers: { ...authedHeaders(token), 'Content-Type': 'application/json' },
            data: '{ this is not json',
        });
        expect(badJson.status()).toBe(400);
    });

    test('no bearer token → 401', async ({ request }) => {
        const res = await request.post(orgsUrl(), { data: { name: 'NoAuth' } });
        expect(res.status()).toBe(401);
    });
});

// ───────────────────────────── PATCH validation ─────────────────────────────

test.describe('PATCH /api/organizations/:id — update validation matrix', () => {
    test('displayName is NOT-NULL: null/empty/wrong-type/>200 → 400; valid → 200', async ({
        request,
    }) => {
        const { token, org } = await freshOwnerWithOrg(request);

        // Explicit null is rejected (@ValidateIf keeps "omitted = no-op" but a
        // present null fails @IsString) — it must NOT reach the NOT-NULL column.
        expect((await patchOrg(request, token, org.id, { displayName: null })).status()).toBe(400);
        expect((await patchOrg(request, token, org.id, { displayName: '' })).status()).toBe(400);
        expect(
            (await patchOrg(request, token, org.id, { displayName: 'a'.repeat(201) })).status(),
        ).toBe(400);
        for (const bad of [123, true, ['x'], { x: 1 }]) {
            expect(
                (await patchOrg(request, token, org.id, { displayName: bad })).status(),
                `displayName=${JSON.stringify(bad)}`,
            ).toBe(400);
        }

        const ok = await patchOrg(request, token, org.id, { displayName: `Renamed ${stamp()}` });
        expect(ok.status()).toBe(200);
    });

    test('displayName length boundary: 200 ok, 201 → 400', async ({ request }) => {
        const { token, org } = await freshOwnerWithOrg(request);
        expect(
            (await patchOrg(request, token, org.id, { displayName: 'b'.repeat(200) })).status(),
        ).toBe(200);
        expect(
            (await patchOrg(request, token, org.id, { displayName: 'b'.repeat(201) })).status(),
        ).toBe(400);
    });

    test('legalName is NULLABLE: null clears (200); empty & >200 → 400', async ({ request }) => {
        const { token, org } = await freshOwnerWithOrg(request);

        // Distinct from displayName: an explicit null is a valid "clear" here.
        const cleared = await patchOrg(request, token, org.id, { legalName: null });
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).legalName).toBeNull();

        expect((await patchOrg(request, token, org.id, { legalName: '' })).status()).toBe(400);
        expect(
            (await patchOrg(request, token, org.id, { legalName: 'a'.repeat(201) })).status(),
        ).toBe(400);
        expect(
            (await patchOrg(request, token, org.id, { legalName: 'a'.repeat(200) })).status(),
        ).toBe(200);
    });

    test('countryCode is EXACTLY length-2 + nullable + stored VERBATIM (not uppercased)', async ({
        request,
    }) => {
        const { token, org } = await freshOwnerWithOrg(request);

        expect((await patchOrg(request, token, org.id, { countryCode: 'U' })).status()).toBe(400);
        expect((await patchOrg(request, token, org.id, { countryCode: 'USA' })).status()).toBe(400);
        expect((await patchOrg(request, token, org.id, { countryCode: '' })).status()).toBe(400);
        for (const bad of [12, true, ['US']]) {
            expect(
                (await patchOrg(request, token, org.id, { countryCode: bad })).status(),
                `countryCode=${JSON.stringify(bad)}`,
            ).toBe(400);
        }

        const nul = await patchOrg(request, token, org.id, { countryCode: null });
        expect(nul.status()).toBe(200);
        expect((await nul.json()).countryCode).toBeNull();

        // PATCH persists the value as-is — lowercase is NOT normalized to
        // uppercase (contrast register-company below, which DOES uppercase).
        const lower = await patchOrg(request, token, org.id, { countryCode: 'de' });
        expect(lower.status()).toBe(200);
        expect((await lower.json()).countryCode).toBe('de');
    });

    test('PATCH vision: null clears (200); >5000 & non-string → 400', async ({ request }) => {
        const { token, org } = await freshOwnerWithOrg(request);

        const nul = await patchOrg(request, token, org.id, { vision: null });
        expect(nul.status()).toBe(200);
        expect((await nul.json()).vision).toBeNull();

        expect(
            (await patchOrg(request, token, org.id, { vision: 'x'.repeat(5001) })).status(),
        ).toBe(400);
        for (const bad of [123, true, ['x']]) {
            expect(
                (await patchOrg(request, token, org.id, { vision: bad })).status(),
                `vision=${JSON.stringify(bad)}`,
            ).toBe(400);
        }
    });

    test('unknown field → 400; empty body {} → 200 no-op (displayName unchanged)', async ({
        request,
    }) => {
        const { token, org } = await freshOwnerWithOrg(request);

        expect((await patchOrg(request, token, org.id, { bogus: 'x' })).status()).toBe(400);

        const noop = await patchOrg(request, token, org.id, {});
        expect(noop.status()).toBe(200);
        expect((await noop.json()).displayName).toBe(org.displayName);
    });
});

// ─────────────────────── Authz matrix (404-never-403) ───────────────────────

test.describe('Authz matrix — 404-never-403 posture', () => {
    test('PATCH authz: anon 401 / malformed 400 / unknown 404 / no-tenant 401 / cross-tenant 404', async ({
        request,
    }) => {
        const owner = await freshOwnerWithOrg(request);
        const noTenant = await freshToken(request); // fresh user, never made an org
        const otherOwner = await freshOwnerWithOrg(request); // has own tenant

        // anon — no bearer → 401 (guard fires before the handler)
        const anon = await request.patch(`${orgsUrl()}/${owner.org.id}`, {
            data: { displayName: 'x' },
        });
        expect(anon.status()).toBe(401);

        // malformed uuid (authed) → 400 via ParseUUIDPipe
        expect(
            (await patchOrg(request, owner.token, UUID_MALFORMED, { displayName: 'x' })).status(),
        ).toBe(400);

        // syntactically-valid but unknown uuid → 404
        expect(
            (await patchOrg(request, owner.token, UUID_UNKNOWN, { displayName: 'x' })).status(),
        ).toBe(404);

        // tenant-less caller is rejected BEFORE the resource is resolved → 401
        const noTenantRes = await patchOrg(request, noTenant.token, owner.org.id, {
            displayName: 'x',
        });
        expect(noTenantRes.status()).toBe(401);

        // tenant-owning cross-user → 404 (never 403, never a leak of existence)
        const cross = await patchOrg(request, otherOwner.token, owner.org.id, { displayName: 'x' });
        expect(cross.status()).toBe(404);
        const body = await cross.json();
        expect(body.statusCode).toBe(404);
        expect(String(body.message)).toContain(owner.org.id);
    });

    test('upgrade-from-account authz: anon 401 / malformed 400 / unknown 404 / no-tenant 409 / cross-tenant 404', async ({
        request,
    }) => {
        const owner = await freshOwnerWithOrg(request);
        const noTenant = await freshToken(request);
        const otherOwner = await freshOwnerWithOrg(request);
        const upgradeUrl = (id: string) => `${orgsUrl()}/${id}/upgrade-from-account`;

        const anon = await request.post(upgradeUrl(owner.org.id));
        expect(anon.status()).toBe(401);

        expect(
            (
                await request.post(upgradeUrl(UUID_MALFORMED), {
                    headers: authedHeaders(owner.token),
                })
            ).status(),
        ).toBe(400);

        // tenant-less caller → 409 (the no-Tenant guard wins over the 404
        // resource check — asserted with a valid-but-unknown id).
        const noTenantRes = await request.post(upgradeUrl(UUID_UNKNOWN), {
            headers: authedHeaders(noTenant.token),
        });
        expect(noTenantRes.status()).toBe(409);

        // owner WITH a tenant but unknown org id → 404
        expect(
            (
                await request.post(upgradeUrl(UUID_UNKNOWN), {
                    headers: authedHeaders(owner.token),
                })
            ).status(),
        ).toBe(404);

        // tenant-owning cross-user on another tenant's org → 404 (no leak)
        const cross = await request.post(upgradeUrl(owner.org.id), {
            headers: authedHeaders(otherOwner.token),
        });
        expect(cross.status()).toBe(404);
    });

    test('read isolation: GET /:slug resolves ANY org (200) but list is tenant-scoped', async ({
        request,
    }) => {
        const owner = await freshOwnerWithOrg(request);
        const other = await freshOwnerWithOrg(request);

        // The slug resolver is intentionally NOT ownership-guarded: a different
        // tenant's authed user can look the org up by slug.
        const bySlug = await request.get(`${orgsUrl()}/${owner.org.slug}`, {
            headers: authedHeaders(other.token),
        });
        expect(bySlug.status()).toBe(200);
        expect((await bySlug.json()).id).toBe(owner.org.id);

        // Unknown slug → 404; anon → 401 (route requires auth).
        expect(
            (
                await request.get(`${orgsUrl()}/no-such-slug-${stamp()}`, {
                    headers: authedHeaders(other.token),
                })
            ).status(),
        ).toBe(404);
        expect((await request.get(`${orgsUrl()}/${owner.org.slug}`)).status()).toBe(401);

        // The LIST endpoint, by contrast, is tenant-scoped — never leaks.
        const list = await request.get(orgsUrl(), { headers: authedHeaders(other.token) });
        expect(list.status()).toBe(200);
        const ids = (await list.json()).map((o: { id: string }) => o.id);
        expect(ids).toContain(other.org.id);
        expect(ids).not.toContain(owner.org.id);
    });
});

// ───────────── create-path divergences + upgrade guard shape ─────────────

test.describe('create-path divergences + upgrade guard', () => {
    test('whitespace-name divergence: create → 409, register-company → 400', async ({
        request,
    }) => {
        const { token } = await freshToken(request);

        const create = await postOrg(request, token, { name: '   ' });
        expect(create.status()).toBe(409);

        const registerCompany = await request.post(`${orgsUrl()}/register-company`, {
            headers: authedHeaders(token),
            data: { name: '   ' },
        });
        expect(registerCompany.status()).toBe(400);
        expect(String((await registerCompany.json()).message)).toContain('required');
    });

    test('register-company countryCode: @Matches strict + UPPERCASED; happy shape', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const rc = (data: unknown) =>
            request.post(`${orgsUrl()}/register-company`, {
                headers: authedHeaders(token),
                data: data as object,
            });

        // Not-exactly-2-letters is rejected by the DTO's @Matches.
        expect((await rc({ name: `RC ${stamp()}`, countryCode: 'USA' })).status()).toBe(400);
        expect((await rc({ name: `RC ${stamp()}`, countryCode: '12' })).status()).toBe(400);
        expect((await rc({ name: `RC ${stamp()}`, bogus: 'x' })).status()).toBe(400);

        // Lowercase 2-letter passes and is UPPERCASED by the controller.
        const ok = await rc({ name: `RC ${stamp()}`, legalName: 'RC, Inc.', countryCode: 'de' });
        expect(ok.status()).toBe(201);
        const body = await ok.json();
        expect(body.countryCode).toBe('DE');
        expect(body.registrationProvider).toBe('manual');
        expect(body.registrationStatus).toBe('registered');
        expect(typeof body.linkedWorkId).toBe('string');
    });

    test('register-company requires a bearer token → 401', async ({ request }) => {
        const res = await request.post(`${orgsUrl()}/register-company`, {
            data: { name: 'RC NoAuth' },
        });
        expect(res.status()).toBe(401);
    });

    test('upgrade guard: first-org → 201 with counts shape; after 2nd org → 409 coded', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const first = await createOrganizationViaAPI(request, token, `First ${stamp()}`);

        // First (and only) org — upgrade succeeds. POST default status is 201.
        const upgrade = await request.post(`${orgsUrl()}/${first.id}/upgrade-from-account`, {
            headers: authedHeaders(token),
        });
        expect(upgrade.status()).toBe(201);
        const counts = await upgrade.json();
        expect(counts.organizationId).toBe(first.id);
        expect(typeof counts.tenantId).toBe('string');
        expect(typeof counts.tierARowsUpdated).toBe('number');
        expect(typeof counts.tierBRowsUpdated).toBe('number');
        expect(typeof counts.tierCRowsUpdated).toBe('number');

        // Create a second org → the first-org guard now blocks upgrade.
        await createOrganizationViaAPI(request, token, `Second ${stamp()}`);
        const blocked = await request.post(`${orgsUrl()}/${first.id}/upgrade-from-account`, {
            headers: authedHeaders(token),
        });
        expect(blocked.status()).toBe(409);
        expect((await blocked.json()).code).toBe('UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS');
    });
});
