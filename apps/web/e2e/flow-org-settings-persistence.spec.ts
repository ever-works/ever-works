import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import {
    createOrganizationViaAPI,
    listOrganizationsViaAPI,
    gotoDashboardWithSwitcher,
    expectOrgListedInSwitcher,
    openWorkspaceSwitcher,
} from './helpers/organizations';

/**
 * Organization settings / profile persistence — deep, multi-step integration
 * flows around `PATCH /api/organizations/:id`, the one Organization endpoint
 * the existing org-suite does NOT exercise at all.
 *
 * Sibling org specs cover the OTHER endpoints (so this file is purely additive):
 *   - flow-org-lifecycle-deep.spec.ts        → POST /api/organizations, list,
 *     check-slug, get-by-slug, slug disambiguation, first-org tenantId backfill.
 *   - flow-org-upgrade-from-account.spec.ts   → register-company + upgrade-from-account.
 *   - flow-multi-tenant-isolation.spec.ts / flow-tenant-isolation-resources.spec.ts
 *     → per-resource tenant stamping + cross-user scope on works/agents/tasks.
 *   - organization-create-switch.spec.ts / flow-org-members-rbac.spec.ts → the
 *     UI switcher + work-member RBAC.
 * NONE of them PATCH an Organization's display/legal/country profile, so the
 * settings-update + persistence + validation + visibility surface below is new.
 *
 * ── PROBED against the LIVE stack (sqlite in-memory — the CI driver) on
 *    2026-06-01, BEFORE any assertion below was written (curl http://127.0.0.1:3100):
 *
 *  REGISTER DTO: { username, email, password } (NOT `name` — registerUserViaAPI
 *    maps `name`→`username` for us). LOGIN DTO: ONLY { email, password }.
 *
 *  PATCH /api/organizations/:id  (auth required; NOT @Public)
 *    body whitelist: ONLY { displayName?, legalName?, countryCode? }. Every field
 *      optional → empty body {} is a no-op 200 that returns the row unchanged.
 *    happy: { displayName, legalName, countryCode } → 200 OrganizationResponse with
 *      the new values; `slug`, `id`, `tenantId`, `createdAt` are UNCHANGED (PATCH
 *      never re-allocates the slug), `updatedAt` bumps.
 *    PARTIAL update is a true PATCH: a body with only `displayName` leaves a
 *      previously-set `legalName`/`countryCode` intact (does NOT null them out).
 *    `legalName: null` (and `countryCode:null`) CLEARS the field → 200, value null
 *      (class-validator @IsOptional treats null as "absent" so it passes, and the
 *      repository persists the null).
 *    PRESERVES registration metadata: PATCHing a register-company Org's displayName
 *      keeps registrationProvider:'manual', registrationStatus:'registered',
 *      linkedWorkId:<uuid> untouched — settings edits never disturb the registration
 *      state machine.
 *    countryCode is stored VERBATIM on PATCH (NOT uppercased — contrast with
 *      register-company, which uppercases). 'GB'→'GB', 'de'→'de'. Length is the only
 *      constraint.
 *    VALIDATION (all 400 Bad Request, class-validator array messages):
 *      - displayName '' → "displayName must be longer than or equal to 1 characters"
 *      - countryCode '' / 'd' (1) → "...longer than or equal to 2 characters"
 *      - countryCode 'USA' (3) → "...shorter than or equal to 2 characters"
 *      - unknown key (slug / registrationStatus / registrationProvider) →
 *        "property X should not exist" (whitelist — you CANNOT self-promote an Org
 *        to registered or steal a slug through this endpoint).
 *    AUTH / SCOPE:
 *      - no bearer → 401 { message:'Unauthorized', statusCode:401 }.
 *      - non-uuid :id → 400 "Validation failed (uuid is expected)" (ParseUUIDPipe).
 *      - unknown well-formed uuid (caller HAS a tenant) → 404 "Organization <uuid>
 *        not found", error:'Not Found'.
 *      - cross-tenant (caller has their OWN tenant, targets another tenant's org) →
 *        404 not-leak (same shape as unknown — org.tenantId !== user.tenantId).
 *      - caller with NO tenant (never created an org) → 401 { message:'User has no
 *        Tenant', error:'Unauthorized' } (distinct from the 404 not-leak above).
 *
 *  GET /api/organizations/:slug is a GLOBAL resolver (200 for ANY authed user) — a
 *    PATCH'd profile is immediately visible to a non-member through it, which is how
 *    "settings visible per role" surfaces on this stack (there is no per-field
 *    role-gated org-settings UI page web-side; the WorkspaceSwitcher renders
 *    org.displayName for the owner, and get-by-slug exposes the profile globally).
 *
 *  WorkspaceSwitcher (apps/web/src/components/layout/WorkspaceSwitcher.tsx) labels
 *    each org menuitem by `org.displayName ?? org.slug` — so a renamed org's NEW
 *    displayName shows up in the header dropdown (the real UI read-path for org
 *    settings). Verified via helpers/organizations.ts.
 *
 * Cross-spec isolation: every API-only flow runs on a FRESH registerUserViaAPI()
 * user (Date.now()-unique) so the shared in-memory DB stays clean for sibling specs;
 * the seeded storageState user is mutated ONLY by the UI-driven flow (which creates
 * its OWN throwaway org to rename, never touching pre-existing rows). Counts use
 * toContain. `flow-` filename ⇒ safe vs the playwright.config no-auth testIgnore regex.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface OrgRow {
    id: string;
    tenantId: string;
    slug: string;
    displayName: string | null;
    legalName: string | null;
    countryCode: string | null;
    registrationProvider: string | null;
    registrationStatus: string | null;
    linkedWorkId: string | null;
    createdAt: string;
    updatedAt: string;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** PATCH /api/organizations/:id (raw — caller inspects status). */
function patchOrgRaw(
    request: APIRequestContext,
    token: string | undefined,
    id: string,
    body: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/organizations/${id}`, {
        headers: token ? authedHeaders(token) : {},
        data: body,
    });
}

/** PATCH and assert 200 + return the parsed OrganizationResponse row. */
async function patchOrgOk(
    request: APIRequestContext,
    token: string,
    id: string,
    body: Record<string, unknown>,
): Promise<OrgRow> {
    const res = await patchOrgRaw(request, token, id, body);
    expect(
        res.status(),
        `PATCH ${JSON.stringify(body)} body=${await res.text().catch(() => '')}`,
    ).toBe(200);
    return res.json();
}

/** GET /api/organizations/:slug — the global slug resolver. */
async function getBySlug(request: APIRequestContext, token: string, slug: string): Promise<OrgRow> {
    const res = await request.get(`${API_BASE}/api/organizations/${encodeURIComponent(slug)}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `get-by-slug body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Extract a class-validator message array/string into a single searchable string. */
function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body.message)
        ? (body.message as string[]).join(' | ')
        : String(body.message);
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        // LOGIN DTO is whitelisted — ONLY { email, password }.
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `seed login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token;
}

test.describe('Organization settings persistence (PATCH /api/organizations/:id)', () => {
    test('flow 1: full profile update round-trips and persists across an independent re-read (slug + tenant invariant, updatedAt bumps)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Pre-state: a fresh draft org (born displayName=name, everything else null/draft).
        const org = (await createOrganizationViaAPI(
            request,
            token,
            `Settings Org ${s}`,
        )) as unknown as OrgRow;
        expect(org.id).toMatch(UUID_RE);
        expect(org.legalName).toBeNull();
        expect(org.countryCode).toBeNull();
        expect(org.registrationStatus).toBe('draft');
        const originalSlug = org.slug;
        const originalCreatedAt = org.createdAt;

        // 1. Update all three editable fields in one PATCH.
        const newDisplay = `Renamed Settings ${s}`;
        const newLegal = `Renamed Settings, Inc. ${s}`;
        const patched = await patchOrgOk(request, token, org.id, {
            displayName: newDisplay,
            legalName: newLegal,
            countryCode: 'DE',
        });
        expect(patched.displayName).toBe(newDisplay);
        expect(patched.legalName).toBe(newLegal);
        expect(patched.countryCode).toBe('DE');

        // 2. INVARIANTS: PATCH never re-allocates the slug, never re-keys the row,
        //    never re-stamps the tenant, and never rewrites createdAt — only the
        //    three profile fields (+ updatedAt) move.
        expect(patched.id).toBe(org.id);
        expect(patched.slug, 'PATCH must NOT re-allocate the slug').toBe(originalSlug);
        expect(patched.tenantId).toBe(org.tenantId);
        expect(patched.createdAt).toBe(originalCreatedAt);
        expect(patched.registrationStatus, 'a profile edit must not touch the status').toBe(
            'draft',
        );
        expect(
            new Date(patched.updatedAt).getTime(),
            'updatedAt should advance (or at least not regress) on a real change',
        ).toBeGreaterThanOrEqual(new Date(org.updatedAt).getTime());

        // 3. DURABILITY: re-read the row from the list endpoint (a fresh DB read on
        //    a different query path) — the new values are persisted, not just echoed.
        const list = (await listOrganizationsViaAPI(request, token)) as unknown as OrgRow[];
        const fromList = list.find((o) => o.id === org.id);
        expect(fromList, 'patched org must still be listed under the tenant').toBeTruthy();
        expect(fromList?.displayName).toBe(newDisplay);
        expect(fromList?.legalName).toBe(newLegal);
        expect(fromList?.countryCode).toBe('DE');
        expect(fromList?.slug).toBe(originalSlug);
    });

    test('flow 2: PATCH is a true partial merge — sequential single-field patches accumulate, and null clears a field without disturbing the others', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        const org = (await createOrganizationViaAPI(
            request,
            token,
            `Partial Org ${s}`,
        )) as unknown as OrgRow;

        // 1. Set legalName + countryCode in one patch.
        const step1 = await patchOrgOk(request, token, org.id, {
            legalName: `Acme Holdings ${s}`,
            countryCode: 'US',
        });
        expect(step1.legalName).toBe(`Acme Holdings ${s}`);
        expect(step1.countryCode).toBe('US');
        // displayName is untouched by this patch — still the create-time value.
        expect(step1.displayName).toBe(`Partial Org ${s}`);

        // 2. A SECOND patch touching ONLY displayName must NOT wipe the legalName /
        //    countryCode set in step 1 — proving the update is a column-level merge,
        //    not a full-row replace.
        const step2 = await patchOrgOk(request, token, org.id, {
            displayName: `Acme (rebrand) ${s}`,
        });
        expect(step2.displayName).toBe(`Acme (rebrand) ${s}`);
        expect(step2.legalName, 'a displayName-only patch must preserve legalName').toBe(
            `Acme Holdings ${s}`,
        );
        expect(step2.countryCode, 'a displayName-only patch must preserve countryCode').toBe('US');

        // 3. EXPLICIT CLEAR: send legalName:null → it is wiped to null, while
        //    countryCode + displayName (NOT in this body) stay put. Confirms null is
        //    an explicit "clear", distinct from "absent" (which is a no-op).
        const step3 = await patchOrgOk(request, token, org.id, { legalName: null });
        expect(step3.legalName, 'null explicitly clears legalName').toBeNull();
        expect(step3.countryCode, 'clearing legalName leaves countryCode intact').toBe('US');
        expect(step3.displayName).toBe(`Acme (rebrand) ${s}`);

        // 4. Empty body {} is a documented no-op: returns the current row verbatim
        //    (no field changes, no 4xx). The merge semantics survive an empty patch.
        const noop = await patchOrgOk(request, token, org.id, {});
        expect(noop.legalName).toBeNull();
        expect(noop.countryCode).toBe('US');
        expect(noop.displayName).toBe(`Acme (rebrand) ${s}`);

        // 5. Final durable read confirms the accumulated end-state.
        const fromList = (
            (await listOrganizationsViaAPI(request, token)) as unknown as OrgRow[]
        ).find((o) => o.id === org.id);
        expect(fromList?.displayName).toBe(`Acme (rebrand) ${s}`);
        expect(fromList?.legalName).toBeNull();
        expect(fromList?.countryCode).toBe('US');
    });

    test('flow 3: settings-write validation surface — empty/short/long fields and unknown-key whitelist all 400, and a rejected write never mutates the row', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Establish a known-good baseline so we can prove rejected writes are inert.
        const org = (await createOrganizationViaAPI(
            request,
            token,
            `Validation Org ${s}`,
        )) as unknown as OrgRow;
        const baseline = await patchOrgOk(request, token, org.id, {
            displayName: `Baseline ${s}`,
            legalName: `Baseline LLC ${s}`,
            countryCode: 'FR',
        });

        // (a) Empty displayName → 400 (Length min 1).
        const emptyDisplay = await patchOrgRaw(request, token, org.id, { displayName: '' });
        expect(emptyDisplay.status()).toBe(400);
        expect(msgOf(await emptyDisplay.json())).toMatch(
            /displayName must be longer than or equal to 1/i,
        );

        // (b) countryCode too short ('d', 1 char) AND too long ('USA', 3 chars) →
        //     both 400 with the matching boundary message.
        const ccShort = await patchOrgRaw(request, token, org.id, { countryCode: 'd' });
        expect(ccShort.status()).toBe(400);
        expect(msgOf(await ccShort.json())).toMatch(
            /countryCode must be longer than or equal to 2/i,
        );

        const ccLong = await patchOrgRaw(request, token, org.id, { countryCode: 'USA' });
        expect(ccLong.status()).toBe(400);
        expect(msgOf(await ccLong.json())).toMatch(
            /countryCode must be shorter than or equal to 2/i,
        );

        // (c) WHITELIST: the endpoint exposes ONLY display/legal/country. Attempting
        //     to slip in a privileged field (registrationStatus / registrationProvider
        //     / slug) is rejected — you cannot self-promote an Org to "registered" or
        //     hijack a slug through the settings PATCH.
        const privileged = await patchOrgRaw(request, token, org.id, {
            registrationStatus: 'registered',
            registrationProvider: 'manual',
            slug: `stolen-${s}`,
        });
        expect(privileged.status()).toBe(400);
        const privMsg = msgOf(await privileged.json());
        expect(privMsg).toContain('should not exist');
        expect(privMsg).toMatch(/registrationStatus|registrationProvider|slug/);

        // (d) A whitelisted field combined with an unknown field still fails the
        //     whole request (whitelist is all-or-nothing) — so a partially-valid body
        //     does NOT silently land its valid half.
        const mixed = await patchOrgRaw(request, token, org.id, {
            displayName: `Should Not Stick ${s}`,
            bogusField: true,
        });
        expect(mixed.status()).toBe(400);
        expect(msgOf(await mixed.json())).toContain('bogusField');

        // (e) INERT: after FIVE rejected writes, the row is byte-identical to the
        //     baseline (every 400 short-circuited at the ValidationPipe before the
        //     service ran — no partial mutation).
        const after = ((await listOrganizationsViaAPI(request, token)) as unknown as OrgRow[]).find(
            (o) => o.id === org.id,
        );
        expect(after?.displayName, 'rejected writes must not change displayName').toBe(
            baseline.displayName,
        );
        expect(after?.legalName).toBe(baseline.legalName);
        expect(after?.countryCode).toBe('FR');
        expect(after?.registrationStatus, 'whitelist-rejected status promotion did not land').toBe(
            'draft',
        );
    });

    test('flow 4: editing a registered-company Org rebrands the profile WITHOUT disturbing the registration state machine (provider/status/linkedWork preserved)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // 1. Mint a REGISTERED company (provider=manual, status=registered, backed by
        //    a real Work) via the register-company path — the richest Org shape.
        const rcRes = await request.post(`${API_BASE}/api/organizations/register-company`, {
            headers: authedHeaders(token),
            data: { name: `RegCo ${s}`, countryCode: 'US' },
        });
        expect(rcRes.status(), `register-company body=${await rcRes.text().catch(() => '')}`).toBe(
            201,
        );
        const reg = (await rcRes.json()) as OrgRow;
        expect(reg.registrationProvider).toBe('manual');
        expect(reg.registrationStatus).toBe('registered');
        expect(reg.linkedWorkId).toMatch(UUID_RE);
        const originalLinkedWork = reg.linkedWorkId;

        // 2. Rebrand it through the settings PATCH: new displayName, new legalName,
        //    new countryCode.
        const patched = await patchOrgOk(request, token, reg.id, {
            displayName: `RegCo Rebranded ${s}`,
            legalName: `RegCo International, Inc. ${s}`,
            countryCode: 'GB',
        });
        expect(patched.displayName).toBe(`RegCo Rebranded ${s}`);
        expect(patched.legalName).toBe(`RegCo International, Inc. ${s}`);
        expect(patched.countryCode).toBe('GB');

        // 3. The REGISTRATION STATE MACHINE is untouched by the profile edit — a
        //    settings PATCH is orthogonal to registration. provider/status/linkedWork
        //    all survive verbatim (you can rebrand a registered company without
        //    accidentally re-drafting it or unlinking its backing Work).
        expect(patched.registrationProvider, 'provider preserved through a profile edit').toBe(
            'manual',
        );
        expect(patched.registrationStatus, 'status stays registered').toBe('registered');
        expect(patched.linkedWorkId, 'backing Work link preserved').toBe(originalLinkedWork);
        expect(patched.slug, 'slug unchanged').toBe(reg.slug);
        expect(patched.tenantId).toBe(reg.tenantId);

        // 4. Durable re-read confirms the registered metadata persisted alongside the
        //    rebrand (not just echoed in the PATCH response).
        const fromList = (
            (await listOrganizationsViaAPI(request, token)) as unknown as OrgRow[]
        ).find((o) => o.id === reg.id);
        expect(fromList?.registrationStatus).toBe('registered');
        expect(fromList?.registrationProvider).toBe('manual');
        expect(fromList?.linkedWorkId).toBe(originalLinkedWork);
        expect(fromList?.displayName).toBe(`RegCo Rebranded ${s}`);
    });

    test('flow 5: settings-write authorization boundary — owner edits; cross-tenant 404 not-leak; no-tenant 401; unknown 404; non-uuid 400; unauth 401 (and none of the foreign probes mutate the target)', async ({
        request,
    }) => {
        const s = stamp();

        // Owner A: a single-org tenant whose org we probe against from other identities.
        const userA = await registerUserViaAPI(request);
        const orgA = (await createOrganizationViaAPI(
            request,
            userA.access_token,
            `AuthZ A ${s}`,
        )) as unknown as OrgRow;
        // A sets a known profile so we can prove foreign probes leave it intact.
        const owned = await patchOrgOk(request, userA.access_token, orgA.id, {
            displayName: `AuthZ A Owned ${s}`,
            legalName: `AuthZ A Legal ${s}`,
            countryCode: 'US',
        });
        expect(owned.displayName).toBe(`AuthZ A Owned ${s}`);

        // (a) CROSS-TENANT: user B HAS their own tenant (clears the no-tenant guard)
        //     but targets A's org → 404 not-leak (org.tenantId !== B.tenantId is
        //     reported identically to a genuinely-missing id, so B can't even confirm
        //     A's org exists).
        const userB = await registerUserViaAPI(request);
        await createOrganizationViaAPI(request, userB.access_token, `AuthZ B ${s}`);
        const crossRes = await patchOrgRaw(request, userB.access_token, orgA.id, {
            displayName: 'HIJACK',
        });
        expect(crossRes.status(), 'cross-tenant PATCH must 404 not-leak').toBe(404);
        const crossBody = await crossRes.json();
        expect(crossBody.error).toBe('Not Found');
        expect(String(crossBody.message)).toContain(orgA.id);

        // (b) NO-TENANT caller (fresh user who never created an org) → 401 with the
        //     distinctive "User has no Tenant" message — a DIFFERENT guard from the
        //     404 above (proves the two rejection paths are not conflated).
        const userC = await registerUserViaAPI(request);
        const noTenantRes = await patchOrgRaw(request, userC.access_token, orgA.id, {
            displayName: 'NO TENANT',
        });
        expect(noTenantRes.status()).toBe(401);
        expect(String((await noTenantRes.json()).message)).toContain('no Tenant');

        // (c) UNKNOWN well-formed uuid for a user WITH a tenant (B) → 404 (confirms
        //     (a)'s 404 was ownership-scoped, not a blanket reject).
        const unknownRes = await patchOrgRaw(request, userB.access_token, UNKNOWN_UUID, {
            displayName: 'GHOST',
        });
        expect(unknownRes.status()).toBe(404);
        expect(String((await unknownRes.json()).message)).toContain(UNKNOWN_UUID);

        // (d) NON-uuid :id → 400 ParseUUIDPipe BEFORE any service/auth logic.
        const badId = await patchOrgRaw(request, userA.access_token, 'not-a-uuid', {
            displayName: 'X',
        });
        expect(badId.status()).toBe(400);
        expect(String((await badId.json()).message)).toMatch(/uuid is expected/i);

        // (e) No bearer → 401 (endpoint is guarded).
        const anon = await patchOrgRaw(request, undefined, orgA.id, { displayName: 'ANON' });
        expect(anon.status()).toBe(401);

        // (f) After EVERY foreign/anon probe above, A's org profile is untouched —
        //     none of the rejected writes leaked a partial mutation across the tenant
        //     boundary.
        const aFresh = (
            (await listOrganizationsViaAPI(request, userA.access_token)) as unknown as OrgRow[]
        ).find((o) => o.id === orgA.id);
        expect(aFresh?.displayName, 'owner profile survived all foreign probes').toBe(
            `AuthZ A Owned ${s}`,
        );
        expect(aFresh?.legalName).toBe(`AuthZ A Legal ${s}`);
        expect(aFresh?.countryCode).toBe('US');
    });

    test('flow 6: a settings rename is visible to a non-member via the global slug resolver AND propagates to the owner’s WorkspaceSwitcher header (cross-boundary read-path)', async ({
        page,
        request,
        baseURL,
    }) => {
        const s = stamp();

        // OWNER = the seeded storageState user (so the UI is already authenticated).
        // We create a THROWAWAY org to rename — never touching the seeded user's
        // pre-existing rows — so this UI-mutating flow stays isolation-safe.
        const token = await seededToken(request);
        const initialName = `Switcher Org ${s}`;
        const org = (await createOrganizationViaAPI(
            request,
            token,
            initialName,
        )) as unknown as OrgRow;
        const slug = org.slug;

        // A NON-MEMBER reader: a different user with their OWN tenant (so they're
        // authenticated but in no way related to the seeded user's tenant).
        const reader = await registerUserViaAPI(request);
        await createOrganizationViaAPI(request, reader.access_token, `Reader Org ${s}`);

        // 1. Before the rename, the non-member can resolve the org by slug (global
        //    resolver) and sees the original display name. This is the "settings
        //    visible across the membership boundary" read-path on this stack.
        const before = await getBySlug(request, reader.access_token, slug);
        expect(before.id).toBe(org.id);
        expect(before.displayName).toBe(initialName);

        // 2. OWNER renames the org via the settings PATCH.
        const renamed = `Switcher Org Renamed ${s}`;
        const patched = await patchOrgOk(request, token, org.id, {
            displayName: renamed,
            legalName: `Switcher Org Legal ${s}`,
        });
        expect(patched.displayName).toBe(renamed);
        expect(patched.slug, 'rename keeps the slug stable so deep links survive').toBe(slug);

        // 3. The non-member immediately sees the NEW profile through the same global
        //    resolver (no caching staleness, no membership required to read it).
        await expect
            .poll(async () => (await getBySlug(request, reader.access_token, slug)).displayName, {
                timeout: 15_000,
                message: 'non-member should see the renamed displayName via get-by-slug',
            })
            .toBe(renamed);
        const afterRead = await getBySlug(request, reader.access_token, slug);
        expect(afterRead.legalName).toBe(`Switcher Org Legal ${s}`);
        expect(afterRead.slug).toBe(slug);

        // 4. UI READ-PATH: the owner's WorkspaceSwitcher labels each org menuitem by
        //    displayName, so the renamed org appears in the header dropdown under its
        //    NEW name (and the stale name is gone). This is the real UI surface that
        //    reflects an org-settings change for the owner.
        await gotoDashboardWithSwitcher(page, baseURL);
        await expectOrgListedInSwitcher(page, renamed);

        // The OLD name must NOT linger as a selectable menuitem (rename replaced it,
        // it didn't add a second row).
        await openWorkspaceSwitcher(page);
        await expect(page.getByRole('menuitem', { name: initialName, exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');
    });
});
