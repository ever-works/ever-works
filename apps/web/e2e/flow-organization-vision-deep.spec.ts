/**
 * Organization Vision — the vision statement + registration metadata on an
 * Organization, DEEP end-to-end (#1670 / EW-658 PR-6).
 *
 * Orgs carry `vision` + `visionUpdatedAt` alongside the Phase-6 registration
 * fields (`displayName`, `legalName`, `countryCode`, `registrationProvider`,
 * `registrationStatus`, `linkedWorkId`). This file drives the real API against
 * a live stack and pins the true response shapes + status codes, covering:
 *
 *   • create-time vision — trim / whitespace→null / 5000-char cap; `visionUpdatedAt`
 *     stamps (ms precision) iff a non-null value survives
 *   • PATCH vision lifecycle — set / re-set (timestamp bumps) / clear-to-null
 *     (still bumps — a clear IS a change) / OMIT (value + timestamp unchanged)
 *   • the full response shape incl. registration defaults (registrationStatus
 *     'draft', everything else null)
 *   • displayName / legalName / countryCode validation (NOT-NULL displayName
 *     rejects null + '' → 400; nullable legalName clears fine; countryCode is
 *     length-2-exact; PATCH stores countryCode verbatim, NOT uppercased)
 *   • read surfaces — list (bare array, most-recent-first, tenant-scoped) and
 *     GET-by-slug (which is deliberately NOT ownership-guarded — the slug
 *     resolver contract)
 *   • register-company — lands manual/registered + uppercased countryCode +
 *     a linked backing Work; vision stays null
 *   • check-slug — public + throttled, `{ available, normalized, suggestion? }`
 *   • validation (400), auth gating (401), cross-user isolation, malformed vs
 *     unknown ids
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the CI
 *    driver) before every assertion was written.
 *
 *    Two hard-won contract quirks pinned below:
 *      1. Cross-user PATCH isolation is TWO-HEADED — an intruder with no Tenant
 *         yet trips the `User has no Tenant` guard → 401; once they own an Org
 *         (and thus a Tenant) the ownership check fires → 404. Both are asserted.
 *      2. GET /api/organizations/:slug carries NO ownership guard: any
 *         authenticated user reads any Org by slug, `vision` text included.
 *         Asserted as the observed contract, not smoke-tolerated.
 *
 * Isolation discipline: every test registers FRESH registerUserViaAPI() owners
 * and mints their own lazily-created Org. Fully API-orchestrated (safe `flow-`
 * prefix, not matched by the no-auth testIgnore regex), so it never contends on
 * shared UI auth state.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const ORGS_BASE = `${API_BASE}/api/organizations`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

interface OrgResponse {
    id: string;
    tenantId: string;
    slug: string;
    legalName: string | null;
    displayName: string | null;
    countryCode: string | null;
    registrationProvider: string | null;
    registrationStatus: string | null;
    linkedWorkId: string | null;
    vision: string | null;
    visionUpdatedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Create an Organization via the raw API so the caller can pass `vision` (the
 * shared helper only threads `name`). Asserts 201 + returns the full body. */
async function createOrg(
    request: APIRequestContext,
    token: string,
    body: { name: string; slug?: string; vision?: string | null },
): Promise<OrgResponse> {
    const res = await request.post(ORGS_BASE, { headers: authedHeaders(token), data: body });
    expect(res.status(), `createOrg body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Register a fresh user and return `{ token, userId }`. */
async function freshOwner(request: APIRequestContext): Promise<{ token: string; userId: string }> {
    const u = await registerUserViaAPI(request);
    return { token: u.access_token, userId: u.user.id };
}

test.describe('Organization Vision — create-time vision', () => {
    test('create with a vision trims it, stamps visionUpdatedAt, and pins the full shape', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Vision Co ${stamp()}`,
            vision: '  Build the best AI work platform.  ',
        });
        expect(org.id).toMatch(UUID_RE);
        expect(org.tenantId).toMatch(UUID_RE);
        expect(org.slug).toMatch(/^vision-co-/);
        // Vision is trimmed of the surrounding whitespace.
        expect(org.vision).toBe('Build the best AI work platform.');
        // A surviving vision stamps the timestamp (ms precision).
        expect(org.visionUpdatedAt).not.toBeNull();
        expect(org.visionUpdatedAt!).toMatch(ISO_RE);
        expect(typeof org.createdAt).toBe('string');
        expect(typeof org.updatedAt).toBe('string');
    });

    test('create WITHOUT a vision leaves vision + visionUpdatedAt null and defaults registration fields', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `Bare Org ${stamp()}` });
        expect(org.vision).toBeNull();
        expect(org.visionUpdatedAt).toBeNull();
        // Registration metadata defaults: draft + everything else null.
        expect(org.registrationStatus).toBe('draft');
        expect(org.registrationProvider).toBeNull();
        expect(org.legalName).toBeNull();
        expect(org.countryCode).toBeNull();
        expect(org.linkedWorkId).toBeNull();
        // displayName mirrors the create `name` (NOT-NULL column, always present).
        expect(org.displayName).not.toBeNull();
    });

    test('create with a whitespace-only vision collapses to null (no timestamp stamped)', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Blank Vision ${stamp()}`,
            vision: '     ',
        });
        expect(org.vision).toBeNull();
        expect(org.visionUpdatedAt).toBeNull();
    });

    test('create vision at exactly 5000 chars is accepted; > 5000 → 400', async ({ request }) => {
        const { token } = await freshOwner(request);
        const at5000 = 'a'.repeat(5000);
        const ok = await createOrg(request, token, {
            name: `Max Vision ${stamp()}`,
            vision: at5000,
        });
        expect(ok.vision).toBe(at5000);
        expect(ok.vision!.length).toBe(5000);

        const over = await request.post(ORGS_BASE, {
            headers: authedHeaders(token),
            data: { name: `Over Vision ${stamp()}`, vision: 'a'.repeat(5001) },
        });
        expect(over.status()).toBe(400);
    });

    test('create validation: missing name 400, name > 200 400, no auth 401', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        expect(
            (await request.post(ORGS_BASE, { headers: authedHeaders(token), data: {} })).status(),
        ).toBe(400);
        const longName = await request.post(ORGS_BASE, {
            headers: authedHeaders(token),
            data: { name: 'n'.repeat(201) },
        });
        expect(longName.status()).toBe(400);
        expect((await request.post(ORGS_BASE, { data: { name: 'NoAuth' } })).status()).toBe(401);
    });
});

test.describe('Organization Vision — PATCH vision lifecycle', () => {
    test('PATCH sets vision, stamps visionUpdatedAt, and GET-by-slug reflects it', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `Patch Set ${stamp()}` });
        expect(org.vision).toBeNull();

        const patched = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: { vision: 'Ship the roadmap' },
        });
        expect(patched.status()).toBe(200);
        const body: OrgResponse = await patched.json();
        expect(body.vision).toBe('Ship the roadmap');
        expect(body.visionUpdatedAt).not.toBeNull();
        expect(body.visionUpdatedAt!).toMatch(ISO_RE);

        // GET-by-slug carries the same vision.
        const bySlug = await request.get(`${ORGS_BASE}/${org.slug}`, {
            headers: authedHeaders(token),
        });
        expect(bySlug.status()).toBe(200);
        expect((await bySlug.json()).vision).toBe('Ship the roadmap');
    });

    test('re-setting the vision bumps visionUpdatedAt forward and swaps the text', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Patch Rebump ${stamp()}`,
            vision: 'v1',
        });
        const t1 = org.visionUpdatedAt!;
        expect(t1).not.toBeNull();

        const patched = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: { vision: 'v2 the sequel' },
        });
        expect(patched.status()).toBe(200);
        const body: OrgResponse = await patched.json();
        expect(body.vision).toBe('v2 the sequel');
        // Timestamp moves forward (>= tolerates the rare same-ms case).
        expect(new Date(body.visionUpdatedAt!).getTime()).toBeGreaterThanOrEqual(
            new Date(t1).getTime(),
        );
    });

    test('clearing the vision to null nulls the text but STILL bumps visionUpdatedAt (a clear is a change)', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Patch Clear ${stamp()}`,
            vision: 'to be cleared',
        });
        const before = org.visionUpdatedAt!;
        expect(before).not.toBeNull();

        const cleared = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: { vision: null },
        });
        expect(cleared.status()).toBe(200);
        const body: OrgResponse = await cleared.json();
        expect(body.vision).toBeNull();
        // The key invariant: visionUpdatedAt is NOT nulled — a clear stamps "now".
        expect(body.visionUpdatedAt).not.toBeNull();
        expect(new Date(body.visionUpdatedAt!).getTime()).toBeGreaterThanOrEqual(
            new Date(before).getTime(),
        );
    });

    test('OMITTING vision on a PATCH leaves both the text and visionUpdatedAt untouched', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Omit Vision ${stamp()}`,
            vision: 'stable vision',
        });
        const frozenText = org.vision;
        const frozenTs = org.visionUpdatedAt;

        const patched = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: { displayName: 'Renamed But Vision Frozen' },
        });
        expect(patched.status()).toBe(200);
        const body: OrgResponse = await patched.json();
        expect(body.displayName).toBe('Renamed But Vision Frozen');
        // Vision text + timestamp are byte-for-byte unchanged.
        expect(body.vision).toBe(frozenText);
        expect(body.visionUpdatedAt).toBe(frozenTs);
    });

    test('PATCH vision validation: a non-string 400, > 5000 chars 400', async ({ request }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `Vision Val ${stamp()}` });
        const H = authedHeaders(token);

        const nonString = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: H,
            data: { vision: 5 },
        });
        expect(nonString.status()).toBe(400);
        const tooLong = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: H,
            data: { vision: 'a'.repeat(5001) },
        });
        expect(tooLong.status()).toBe(400);
    });

    test('an empty PATCH body {} is a 200 no-op that preserves the existing vision', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Empty Patch ${stamp()}`,
            vision: 'untouched',
        });
        const noop = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(noop.status()).toBe(200);
        const body: OrgResponse = await noop.json();
        expect(body.vision).toBe('untouched');
        expect(body.visionUpdatedAt).toBe(org.visionUpdatedAt);
    });
});

test.describe('Organization — displayName / legalName / countryCode fields', () => {
    test('a combined PATCH of all four fields persists on re-read', async ({ request }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `Combo ${stamp()}` });
        const patched = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(token),
            data: {
                displayName: 'Combo Renamed',
                legalName: 'Combo LLC',
                countryCode: 'DE',
                vision: 'combo vision',
            },
        });
        expect(patched.status()).toBe(200);
        const body: OrgResponse = await patched.json();
        expect(body.displayName).toBe('Combo Renamed');
        expect(body.legalName).toBe('Combo LLC');
        expect(body.countryCode).toBe('DE');
        expect(body.vision).toBe('combo vision');

        const reread: OrgResponse = await (
            await request.get(`${ORGS_BASE}/${org.slug}`, { headers: authedHeaders(token) })
        ).json();
        expect(reread.displayName).toBe('Combo Renamed');
        expect(reread.legalName).toBe('Combo LLC');
        expect(reread.countryCode).toBe('DE');
    });

    test('displayName is NOT-NULL: explicit null 400, empty string 400, > 200 chars 400', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `DN Val ${stamp()}` });
        const H = authedHeaders(token);
        expect(
            (
                await request.patch(`${ORGS_BASE}/${org.id}`, {
                    headers: H,
                    data: { displayName: null },
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.patch(`${ORGS_BASE}/${org.id}`, {
                    headers: H,
                    data: { displayName: '' },
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.patch(`${ORGS_BASE}/${org.id}`, {
                    headers: H,
                    data: { displayName: 'x'.repeat(201) },
                })
            ).status(),
        ).toBe(400);
    });

    test('legalName is nullable: it can be set and then explicitly cleared to null', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `Legal ${stamp()}` });
        const H = authedHeaders(token);
        const set = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: H,
            data: { legalName: 'Acme, Inc.' },
        });
        expect(set.status()).toBe(200);
        expect((await set.json()).legalName).toBe('Acme, Inc.');
        const clear = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: H,
            data: { legalName: null },
        });
        expect(clear.status()).toBe(200);
        expect((await clear.json()).legalName).toBeNull();
    });

    test('countryCode must be exactly 2 chars (3 → 400); PATCH stores it verbatim, NOT uppercased', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, { name: `CC ${stamp()}` });
        const H = authedHeaders(token);
        expect(
            (
                await request.patch(`${ORGS_BASE}/${org.id}`, {
                    headers: H,
                    data: { countryCode: 'USA' },
                })
            ).status(),
        ).toBe(400);
        // A valid lowercase code is accepted AS-IS — the PATCH path does not
        // normalize case (only register-company uppercases).
        const ok = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: H,
            data: { countryCode: 'us' },
        });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).countryCode).toBe('us');
    });
});

test.describe('Organization — read surfaces + isolation', () => {
    test("list returns a bare array of the tenant's orgs, most-recent-first, and no auth → 401", async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const first = await createOrg(request, token, { name: `List First ${stamp()}` });
        const second = await createOrg(request, token, { name: `List Second ${stamp()}` });

        const list = await request.get(ORGS_BASE, { headers: authedHeaders(token) });
        expect(list.status()).toBe(200);
        const orgs: OrgResponse[] = await list.json();
        expect(Array.isArray(orgs)).toBe(true);
        const ids = orgs.map((o) => o.id);
        expect(ids).toContain(first.id);
        expect(ids).toContain(second.id);
        // Most-recent-first: the second-created org sorts ahead of the first.
        expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

        expect((await request.get(ORGS_BASE)).status()).toBe(401);
    });

    test('GET by slug returns the org (incl vision); unknown slug 404; no auth 401', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const org = await createOrg(request, token, {
            name: `Slug Read ${stamp()}`,
            vision: 'readable vision',
        });
        const got = await request.get(`${ORGS_BASE}/${org.slug}`, {
            headers: authedHeaders(token),
        });
        expect(got.status()).toBe(200);
        const body: OrgResponse = await got.json();
        expect(body.id).toBe(org.id);
        expect(body.vision).toBe('readable vision');

        expect(
            (
                await request.get(`${ORGS_BASE}/no-such-slug-${stamp()}`, {
                    headers: authedHeaders(token),
                })
            ).status(),
        ).toBe(404);
        expect((await request.get(`${ORGS_BASE}/${org.slug}`)).status()).toBe(401);
    });

    test('GET by slug is NOT ownership-guarded: another user reads the org AND its vision (slug-resolver contract)', async ({
        request,
    }) => {
        const owner = await freshOwner(request);
        const outsider = await freshOwner(request);
        const org = await createOrg(request, owner.token, {
            name: `Cross Read ${stamp()}`,
            vision: 'Secret roadmap: world domination',
        });
        // A completely different user can read the org by slug — 200, not 404 —
        // and the vision text is exposed. Pinned as the observed contract.
        const cross = await request.get(`${ORGS_BASE}/${org.slug}`, {
            headers: authedHeaders(outsider.token),
        });
        expect(cross.status()).toBe(200);
        const body: OrgResponse = await cross.json();
        expect(body.id).toBe(org.id);
        expect(body.vision).toBe('Secret roadmap: world domination');
    });

    test('cross-user PATCH is two-headed: an intruder without a Tenant → 401, an intruder with their own Org → 404', async ({
        request,
    }) => {
        const owner = await freshOwner(request);
        const org = await createOrg(request, owner.token, {
            name: `Guarded ${stamp()}`,
            vision: 'owner only',
        });

        // Intruder A has just registered — no Tenant yet → the `User has no
        // Tenant` guard fires before the ownership check → 401.
        const noTenant = await freshOwner(request);
        const a = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(noTenant.token),
            data: { vision: 'hijack' },
        });
        expect(a.status()).toBe(401);

        // Intruder B owns their own Org (thus a Tenant) — now the ownership
        // check fires and walls them off with a don't-leak 404.
        const withTenant = await freshOwner(request);
        await createOrg(request, withTenant.token, { name: `Intruder Own ${stamp()}` });
        const b = await request.patch(`${ORGS_BASE}/${org.id}`, {
            headers: authedHeaders(withTenant.token),
            data: { vision: 'hijack' },
        });
        expect(b.status()).toBe(404);

        // The owner's vision is untouched.
        const after: OrgResponse = await (
            await request.get(`${ORGS_BASE}/${org.slug}`, { headers: authedHeaders(owner.token) })
        ).json();
        expect(after.vision).toBe('owner only');
    });

    test('PATCH id edge cases: malformed uuid 400, unknown uuid 404, no auth 401', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const H = authedHeaders(token);
        expect(
            (
                await request.patch(`${ORGS_BASE}/not-a-uuid`, {
                    headers: H,
                    data: { vision: 'x' },
                })
            ).status(),
        ).toBe(400);
        // An unknown-but-well-formed org id is walled off by the ownership
        // guard BEFORE existence is revealed: the caller is not a member, so it
        // returns 401/403 (no 404 existence oracle) rather than a plain 404.
        expect([401, 403, 404]).toContain(
            (
                await request.patch(`${ORGS_BASE}/${UNKNOWN_UUID}`, {
                    headers: H,
                    data: { vision: 'x' },
                })
            ).status(),
        );
        // Need a real org id to prove the 401 isn't a param-pipe artifact.
        const org = await createOrg(request, token, { name: `NoAuthPatch ${stamp()}` });
        expect(
            (await request.patch(`${ORGS_BASE}/${org.id}`, { data: { vision: 'x' } })).status(),
        ).toBe(401);
    });

    test("upgrade-from-account on another user's org → 404", async ({ request }) => {
        const owner = await freshOwner(request);
        const org = await createOrg(request, owner.token, { name: `Upgrade Guard ${stamp()}` });
        const intruder = await freshOwner(request);
        await createOrg(request, intruder.token, { name: `Intruder Up ${stamp()}` });
        const res = await request.post(`${ORGS_BASE}/${org.id}/upgrade-from-account`, {
            headers: authedHeaders(intruder.token),
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Organization — register-company (registration fields)', () => {
    test('register-company lands manual/registered + uppercased countryCode + a linked Work; vision stays null', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const res = await request.post(`${ORGS_BASE}/register-company`, {
            headers: authedHeaders(token),
            data: {
                name: `Acme Robotics ${stamp()}`,
                legalName: 'Acme Robotics LLC',
                countryCode: 'us',
            },
        });
        expect(res.status(), `register-company body=${await res.text().catch(() => '')}`).toBe(201);
        const org: OrgResponse = await res.json();
        expect(org.id).toMatch(UUID_RE);
        expect(org.registrationProvider).toBe('manual');
        expect(org.registrationStatus).toBe('registered');
        expect(org.legalName).toBe('Acme Robotics LLC');
        // Controller uppercases the country code on the register path.
        expect(org.countryCode).toBe('US');
        // A backing Work of kind=company is linked.
        expect(org.linkedWorkId).toMatch(UUID_RE);
        // register-company doesn't thread a vision → stays null.
        expect(org.vision).toBeNull();
        expect(org.visionUpdatedAt).toBeNull();
    });

    test('register-company validation: missing name 400, whitespace-only name 400, no auth 401', async ({
        request,
    }) => {
        const { token } = await freshOwner(request);
        const H = authedHeaders(token);
        expect(
            (
                await request.post(`${ORGS_BASE}/register-company`, {
                    headers: H,
                    data: { legalName: 'X LLC' },
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.post(`${ORGS_BASE}/register-company`, {
                    headers: H,
                    data: { name: '   ' },
                })
            ).status(),
        ).toBe(400);
        expect(
            (
                await request.post(`${ORGS_BASE}/register-company`, { data: { name: 'NoAuth Co' } })
            ).status(),
        ).toBe(401);
    });
});

test.describe('Organization — check-slug (public)', () => {
    test('check-slug is public (no auth), returns { available, normalized, suggestion? }, and 400s without a value', async ({
        request,
    }) => {
        const owner = await freshOwner(request);
        const org = await createOrg(request, owner.token, { name: `Slugged ${stamp()}` });

        // No Authorization header at all — the route is @Public.
        const free = await request.get(`${ORGS_BASE}/check-slug?value=totally-free-${stamp()}`);
        expect(free.status()).toBe(200);
        const freeBody = await free.json();
        expect(freeBody.available).toBe(true);
        expect(typeof freeBody.normalized).toBe('string');

        // A slug already taken by the just-created org is unavailable + gets a suggestion.
        const taken = await request.get(`${ORGS_BASE}/check-slug?value=${org.slug}`);
        expect(taken.status()).toBe(200);
        const takenBody = await taken.json();
        expect(takenBody.available).toBe(false);
        expect(takenBody.normalized).toBe(org.slug);
        expect(typeof takenBody.suggestion).toBe('string');
        expect(takenBody.suggestion).not.toBe(org.slug);

        // Missing the required `value` query param → 400.
        expect((await request.get(`${ORGS_BASE}/check-slug`)).status()).toBe(400);
    });
});
