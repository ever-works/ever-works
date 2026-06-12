import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI, listOrganizationsViaAPI } from './helpers/organizations';
import { createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Organization upgrade-from-account + register-company — deep cross-feature
 * integration flows around the two EW-658/EW-662/EW-665 endpoints that the
 * existing org specs do NOT touch:
 *
 *   - `POST /api/organizations/:id/upgrade-from-account` (the lazy-upgrade /
 *     personal→org migration path), and
 *   - `POST /api/organizations/register-company` (the Company-chip flow that
 *     lands a backing Work + mints a tenant in one shot).
 *
 * The sibling org specs cover the OTHER endpoints:
 *   - flow-org-lifecycle-deep.spec.ts  → POST /api/organizations, list,
 *     check-slug, get-by-slug, slug disambiguation, first-org tenantId backfill.
 *   - flow-multi-tenant-isolation.spec.ts → per-resource tenant stamping +
 *     cross-user scope guards on works/agents/tasks/missions/orgs.
 *   - organization-create-switch.spec.ts / flow-org-members-rbac.spec.ts → UI
 *     switcher + work-member RBAC.
 * NONE of them exercise upgrade-from-account or register-company, so this file
 * is additive.
 *
 * ── PROBED against the LIVE stack (sqlite in-memory — the CI driver) on
 *    2026-05-31, BEFORE any assertion below was written (curl http://127.0.0.1:3100):
 *
 *  POST /api/organizations/register-company
 *    body whitelist: ONLY { name, legalName?, countryCode?, slug? }. Any other
 *    key (contactEmail/website/description/…) → 400 "property X should not exist".
 *    { name } only → 201 OrganizationResponse:
 *      { id, tenantId, slug, legalName (DEFAULTS to name when omitted),
 *        displayName, countryCode:null, registrationProvider:'manual',
 *        registrationStatus:'registered', linkedWorkId:<a real Work uuid>,
 *        createdAt, updatedAt }.
 *      ⇒ This is the KEY contrast with POST /api/organizations, whose org is
 *        born registrationProvider:null, registrationStatus:'draft',
 *        linkedWorkId:null. register-company is the "registered Company" path.
 *    missing/empty name → 400 ["name must be longer than or equal to 1 characters",
 *        "name must be a string"].
 *    countryCode 'us' → persisted UPPERCASED as 'US'. 'USA' (3 letters) → 400
 *        ["countryCode must be a 2-letter ISO 3166-1 alpha-2 code"].
 *    no bearer → 401 { message:'Unauthorized', statusCode:401 }.
 *    Side-effect: lazily mints the user's Tenant and runs the SAME unconditional
 *      tenantId backfill as POST /api/organizations — a pre-existing task goes
 *      from tenantId:null to the new tenantId (organizationId STAYS null).
 *
 *  POST /api/organizations/:id/upgrade-from-account
 *    happy path (user has exactly ONE org, :id is that org) → **2xx** and the
 *      pre-existing unscoped task/work are pulled INTO the org. The backfill SQL
 *      is now driver-correct: under better-sqlite3 it uses `?` placeholders + an
 *      `… WHERE fk IN (SELECT id FROM parent WHERE …)` subquery in place of the
 *      Postgres-only `UPDATE … FROM parent …` join (organization.service.ts), so
 *      it SUCCEEDS on sqlite exactly as on Postgres prod (it used to 500 here —
 *      that was the bug, found by the unmapped-500 hunt and fixed in this change).
 *    two orgs → **409** { code:'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS',
 *      message:'Upgrade is only available before creating a second Organization' }.
 *      The first-org guard fires BEFORE the backfill, so this 409 is reachable
 *      and deterministic on sqlite (it never reaches the Postgres-only SQL).
 *    unknown well-formed uuid → 404 { message:'Organization <uuid> not found',
 *      error:'Not Found', statusCode:404 }.
 *    non-uuid → 400 { message:'Validation failed (uuid is expected)' } (ParseUUIDPipe).
 *    user with NO tenant (never created an org) → 409 { message:'User has no
 *      Tenant — create an Organization first via POST /api/organizations',
 *      error:'Conflict', statusCode:409 }.
 *    cross-tenant (caller HAS their own tenant, targets another user's org id) →
 *      404 not-leak (same shape as unknown), because org.tenantId !== user.tenantId.
 *    no bearer → 401.
 *
 * ── ENVIRONMENT NOTE: the upgrade happy-path now runs end-to-end on BOTH the CI
 *    sqlite driver and Postgres prod (the backfill SQL is driver-conditional), so
 *    flow 5 asserts the real success contract (2xx + the task pulled into the
 *    org). Every flow asserts a deterministic, driver-stable status
 *    (2xx/409/404/400/401).
 *
 * Cross-spec isolation: every flow runs on a FRESH registerUserViaAPI() user
 * (Date.now()-unique) so the shared in-memory DB stays clean for sibling specs;
 * the seeded storageState user is never mutated. Counts use toContain, never
 * exact global equality. Fully API-orchestrated + `flow-` filename ⇒ safe vs the
 * playwright.config no-auth testIgnore regex and doesn't contend on the UI stack.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const UPGRADE_NOT_AVAILABLE = 'UPGRADE_NOT_AVAILABLE_AFTER_MULTIPLE_ORGS';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** POST /api/organizations/register-company (raw — caller inspects status). */
async function registerCompanyRaw(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/organizations/register-company`, {
        headers: authedHeaders(token),
        data: body,
    });
}

/** POST /api/organizations/:id/upgrade-from-account (raw — caller inspects status). */
async function upgradeRaw(request: APIRequestContext, token: string | undefined, orgId: string) {
    return request.post(`${API_BASE}/api/organizations/${orgId}/upgrade-from-account`, {
        headers: token ? authedHeaders(token) : {},
    });
}

/** GET /api/tasks/:id (returns the bare task row; tenantId/organizationId are exposed). */
async function getTask(request: APIRequestContext, token: string, taskId: string) {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Organization register-company — registered Company path mints tenant + backs a Work', () => {
    test('flow 1: register-company lands a registered Org (provider=manual, linkedWorkId set) distinct from a plain draft Org', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // Fresh user has no Tenant yet → empty org list (the pre-state the
        // register-company tenant-mint hangs off of).
        expect(await listOrganizationsViaAPI(request, token)).toEqual([]);

        // 1. Register a Company with the minimal body. PROBED: { name } only is
        //    sufficient; legalName defaults to name, country is null.
        const companyName = `RC Co ${s}`;
        const res = await registerCompanyRaw(request, token, { name: companyName });
        expect(res.status(), `register-company body=${await res.text().catch(() => '')}`).toBe(201);
        const org = await res.json();

        // 2. The registered-Company shape: provider='manual', status='registered',
        //    and a real backing Work id — this is what makes register-company
        //    different from POST /api/organizations (which is draft + no Work).
        expect(org.id).toMatch(UUID_RE);
        expect(org.tenantId).toMatch(UUID_RE);
        expect(org.slug, 'registered company has an allocated slug').toBeTruthy();
        expect(org.displayName).toBe(companyName);
        // legalName defaults to the display name when omitted (probed).
        expect(org.legalName).toBe(companyName);
        expect(org.registrationProvider).toBe('manual');
        expect(org.registrationStatus).toBe('registered');
        expect(org.linkedWorkId, 'register-company links a backing Work').toMatch(UUID_RE);
        expect(org.countryCode).toBeNull();

        // 3. The mint is real: the org is now listed under the lazily-created Tenant.
        const list = await listOrganizationsViaAPI(request, token);
        expect(list.map((o) => o.id)).toContain(org.id);
        expect(list.every((o) => o.tenantId === org.tenantId)).toBe(true);

        // 4. CONTRAST: a plain POST /api/organizations on the SAME user reuses the
        //    SAME tenant but is born draft + unlinked — proving the two creation
        //    paths produce genuinely different registration metadata, not a fluke.
        const plain = await createOrganizationViaAPI(request, token, `Plain Org ${s}`);
        expect(plain.tenantId).toBe(org.tenantId); // one tenant per user
        expect((plain as { registrationStatus?: string }).registrationStatus).toBe('draft');
        // The Organization helper's narrow type omits these, so read defensively.
        const plainRaw = plain as unknown as {
            registrationProvider: string | null;
            linkedWorkId: string | null;
        };
        expect(plainRaw.registrationProvider).toBeNull();
        expect(plainRaw.linkedWorkId).toBeNull();
        expect(plain.id).not.toBe(org.id);
    });

    test('flow 2: register-company lazily mints the tenant AND backfills tenantId onto a pre-existing task (organizationId stays null)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // 1. Create a Tier-A row (task) BEFORE any org/tenant exists. PROBED: it
        //    is born tenantId:null, organizationId:null (no Tenant to stamp from).
        const task = await createTaskViaAPI(request, token, { title: `RC pre task ${s}` });
        const born = await getTask(request, token, task.id);
        expect(born.tenantId, 'pre-org task is unscoped').toBeNull();
        expect(born.organizationId).toBeNull();

        // 2. register-company runs the SAME unconditional tenantId backfill as
        //    POST /api/organizations (it calls createOrganization under the hood),
        //    so the pre-existing task must inherit the new tenant.
        const res = await registerCompanyRaw(request, token, {
            name: `RC Mint ${s}`,
            legalName: `RC Mint LLC ${s}`,
        });
        expect(res.status(), `register-company body=${await res.text().catch(() => '')}`).toBe(201);
        const org = await res.json();
        expect(org.tenantId).toMatch(UUID_RE);
        // legalName is honoured (NOT defaulted) when explicitly supplied.
        expect(org.legalName).toBe(`RC Mint LLC ${s}`);

        // 3. The task's tenantId is now the company's tenantId; organizationId
        //    STAYS null (the backfill stamps tenantId only — pulling rows into the
        //    org is a SEPARATE upgrade-from-account step, see flow 5/6).
        const afterTask = await getTask(request, token, task.id);
        expect(afterTask.tenantId, 'register-company backfilled the task tenantId').toBe(
            org.tenantId,
        );
        expect(
            afterTask.organizationId,
            'register-company does NOT pull the task into the org (that is upgrade-from-account)',
        ).toBeNull();
        // No data loss: the row is otherwise identical.
        expect(afterTask.id).toBe(task.id);
        expect(afterTask.title).toBe(`RC pre task ${s}`);
    });

    test('flow 3: register-company validation + auth surface (whitelist, name, countryCode, bearer)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // (a) Body whitelist: keys outside { name, legalName, countryCode, slug }
        //     are rejected 400 with the exact "should not exist" messages — this
        //     is the create-modal contract (no contactEmail/website fields v1).
        const extra = await registerCompanyRaw(request, token, {
            name: `Whitelist Co ${s}`,
            contactEmail: 'hi@acme.test',
            website: 'https://acme.test',
        });
        expect(extra.status()).toBe(400);
        const extraBody = await extra.json();
        const extraMsg = Array.isArray(extraBody.message)
            ? (extraBody.message as string[]).join(' | ')
            : String(extraBody.message);
        expect(extraMsg).toContain('contactEmail');
        expect(extraMsg).toContain('should not exist');

        // (b) Missing name → 400 with the class-validator length+type messages.
        const noName = await registerCompanyRaw(request, token, { legalName: 'No Name LLC' });
        expect(noName.status()).toBe(400);
        const noNameMsg = (await noName.json()).message as string[] | string;
        expect(JSON.stringify(noNameMsg)).toMatch(/name must (be a string|be longer)/i);

        // (c) Empty/whitespace name → the controller's pre-Work trim guard (it
        //     rejects BEFORE creating the backing Work, so no orphan Work leaks).
        //     The DTO @Length(1,200) counts whitespace so '   ' passes validation
        //     but the controller trim-check 400s it. Either way it's a 4xx.
        const blankName = await registerCompanyRaw(request, token, { name: '   ' });
        expect(blankName.status(), 'whitespace name must be rejected 4xx').toBeGreaterThanOrEqual(
            400,
        );
        expect(blankName.status()).toBeLessThan(500);

        // (d) countryCode must be ISO-3166-1 alpha-2. 'USA' (3 letters) → 400.
        const badCc = await registerCompanyRaw(request, token, {
            name: `Bad CC ${s}`,
            countryCode: 'USA',
        });
        expect(badCc.status()).toBe(400);
        expect(JSON.stringify((await badCc.json()).message)).toMatch(/2-letter|alpha-2/i);

        // (e) Valid lowercase countryCode is accepted AND uppercased on persist.
        const goodCc = await registerCompanyRaw(request, token, {
            name: `Good CC ${s}`,
            countryCode: 'us',
        });
        expect(goodCc.status(), `good cc body=${await goodCc.text().catch(() => '')}`).toBe(201);
        expect((await goodCc.json()).countryCode, 'countryCode is uppercased server-side').toBe(
            'US',
        );

        // (f) No bearer → 401 (the endpoint is NOT @Public).
        const anon = await request.post(`${API_BASE}/api/organizations/register-company`, {
            data: { name: `Anon Co ${s}` },
        });
        expect(anon.status()).toBe(401);
    });
});

test.describe('Organization upgrade-from-account — first-org guard + driver-correct migration', () => {
    test('flow 4: the first-org guard 409s deterministically AFTER a second org exists (and never reaches the backfill)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // 1. First org mints the tenant. 2. A SECOND org under the same tenant
        //    trips the first-org guard: upgrade is only allowed while the user
        //    has EXACTLY ONE org.
        const org1 = await createOrganizationViaAPI(request, token, `Guard One ${s}`);
        const org2 = await createOrganizationViaAPI(request, token, `Guard Two ${s}`);
        expect(org1.tenantId).toBe(org2.tenantId); // one tenant per user
        expect(org2.id).not.toBe(org1.id);

        // 3. Upgrading into EITHER org now 409s with the documented code. This is
        //    a sqlite-STABLE assertion: the count-guard runs before the Tier-C
        //    Postgres-only SQL, so it never hits the 500 path.
        for (const orgId of [org1.id, org2.id]) {
            const res = await upgradeRaw(request, token, orgId);
            expect(
                res.status(),
                `two-org upgrade(${orgId}) body=${await res.text().catch(() => '')}`,
            ).toBe(409);
            const body = await res.json();
            expect(body.code).toBe(UPGRADE_NOT_AVAILABLE);
            expect(String(body.message)).toContain('second Organization');
        }

        // 4. The guard is non-mutating: both orgs are intact and still share one
        //    tenant (no half-applied migration left them inconsistent).
        const list = await listOrganizationsViaAPI(request, token);
        const ids = list.map((o) => o.id);
        expect(ids).toContain(org1.id);
        expect(ids).toContain(org2.id);
        expect(new Set(list.map((o) => o.tenantId)).size).toBe(1);
    });

    test('flow 5: the happy upgrade path SUCCEEDS under the sqlite CI driver (driver-correct backfill SQL) and pulls the pre-existing task into the org', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // 1. Pre-existing Tier-A rows that an upgrade migrates: a task + a work.
        //    Born unscoped (no tenant yet).
        const task = await createTaskViaAPI(request, token, { title: `Upgrade task ${s}` });
        const bornTask = await getTask(request, token, task.id);
        expect(bornTask.tenantId).toBeNull();
        expect(bornTask.organizationId).toBeNull();

        // 2. Create the user's FIRST (and only) org → mints the tenant + backfills
        //    tenantId on the task (organizationId stays null). This is the exact
        //    "ready to upgrade" pre-state the endpoint expects.
        const org = await createOrganizationViaAPI(request, token, `Upgrade Org ${s}`);
        expect(org.tenantId).toMatch(UUID_RE);
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `Upgrade Work ${s}`,
            slug: `upgrade-work-${s}`,
        });
        expect(workId).toMatch(UUID_RE);

        const preUpgradeTask = await getTask(request, token, task.id);
        expect(preUpgradeTask.tenantId, 'createOrg backfilled tenantId').toBe(org.tenantId);
        expect(preUpgradeTask.organizationId, 'but NOT yet pulled into the org').toBeNull();

        // 3. Call upgrade-from-account. The backfill SQL is now driver-correct:
        //    under better-sqlite3 (CI) it uses `?` placeholders and an
        //    `… WHERE fk IN (SELECT id FROM parent WHERE …)` subquery in place of
        //    the Postgres-only `UPDATE … FROM` join — so it SUCCEEDS on the sqlite
        //    DB exactly as it does on Postgres prod (it used to 500 here).
        const res = await upgradeRaw(request, token, org.id);
        const bodyText = await res.text().catch(() => '');
        expect([200, 201], `upgrade returned ${res.status()} body=${bodyText}`).toContain(
            res.status(),
        );

        const body = JSON.parse(bodyText) as {
            organizationId?: string;
            tenantId?: string;
            tierARowsUpdated?: number;
        };
        expect(body.organizationId).toBe(org.id);
        expect(body.tenantId).toBe(org.tenantId);
        expect(typeof body.tierARowsUpdated).toBe('number');

        // The task is now pulled INTO the org (organizationId stamped) while its
        // tenantId is unchanged — the migration ran end-to-end under sqlite.
        const afterTask = await getTask(request, token, task.id);
        expect(afterTask.organizationId, 'upgrade pulled the task into the org').toBe(org.id);
        expect(afterTask.tenantId, 'tenantId unchanged by the upgrade').toBe(org.tenantId);

        // The user still has exactly one org — topology intact.
        const list = await listOrganizationsViaAPI(request, token);
        expect(list.map((o) => o.id)).toContain(org.id);
        expect(list.length).toBe(1);
    });

    test('flow 6: upgrade error surface — non-tenant user 409, cross-tenant 404 (not-leak), unknown uuid 404, non-uuid 400, unauth 401', async ({
        request,
    }) => {
        const s = stamp();

        // User A: a fully-formed single-org tenant whose org id we will probe
        //   against from OTHER identities.
        const userA = await registerUserViaAPI(request);
        const orgA = await createOrganizationViaAPI(request, userA.access_token, `ErrSurf A ${s}`);
        expect(orgA.id).toMatch(UUID_RE);

        // (a) FRESH user with NO tenant (never created an org) → 409 Conflict
        //     telling them to create an org first. PROBED: this guard precedes
        //     the org lookup, so it 409s even when :id is a real org id.
        const noTenant = await registerUserViaAPI(request);
        const noTenantRes = await upgradeRaw(request, noTenant.access_token, orgA.id);
        expect(
            noTenantRes.status(),
            `no-tenant upgrade body=${await noTenantRes.text().catch(() => '')}`,
        ).toBe(409);
        const noTenantBody = await noTenantRes.json();
        expect(String(noTenantBody.message)).toContain('no Tenant');
        // NB: this 409 has NO `code` field (it's the no-tenant guard, distinct
        // from the multiple-orgs guard which carries UPGRADE_NOT_AVAILABLE_…).
        expect(noTenantBody.code ?? undefined).toBeUndefined();

        // (b) CROSS-TENANT: user B HAS their own tenant (so they clear the
        //     no-tenant guard) but targets user A's org id → 404 not-leak
        //     (org.tenantId !== B.tenantId is reported as missing, identical
        //     shape to a genuinely unknown id).
        const userB = await registerUserViaAPI(request);
        await createOrganizationViaAPI(request, userB.access_token, `ErrSurf B ${s}`);
        const crossRes = await upgradeRaw(request, userB.access_token, orgA.id);
        expect(crossRes.status(), 'cross-tenant upgrade must 404 not-leak').toBe(404);
        const crossBody = await crossRes.json();
        expect(crossBody.error).toBe('Not Found');
        expect(String(crossBody.message)).toContain(orgA.id);

        // (c) UNKNOWN well-formed uuid for a user WITH a tenant → 404 (same
        //     not-found contract; confirms (b)'s 404 was ownership-scoped, not a
        //     blanket reject).
        const unknownRes = await upgradeRaw(request, userB.access_token, UNKNOWN_UUID);
        expect(unknownRes.status()).toBe(404);
        const unknownBody = await unknownRes.json();
        expect(unknownBody.error).toBe('Not Found');
        expect(String(unknownBody.message)).toContain(UNKNOWN_UUID);

        // (d) NON-uuid path param → 400 ParseUUIDPipe BEFORE any service logic.
        const badId = await upgradeRaw(request, userB.access_token, 'not-a-uuid');
        expect(badId.status()).toBe(400);
        expect(String((await badId.json()).message)).toMatch(/uuid is expected/i);

        // (e) No bearer → 401 (endpoint is guarded).
        const anon = await upgradeRaw(request, undefined, orgA.id);
        expect(anon.status()).toBe(401);

        // (f) User A's own single-org state is untouched by all of the above
        //     foreign/anon probes (no cross-contamination).
        const aList = await listOrganizationsViaAPI(request, userA.access_token);
        expect(aList.map((o) => o.id)).toContain(orgA.id);
        expect(aList.length).toBe(1);
    });
});
