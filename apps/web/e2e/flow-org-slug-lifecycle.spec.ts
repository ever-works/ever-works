import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders } from './helpers/api';

/**
 * flow-org-slug-lifecycle — DEEP Organization-slug allocation / collision /
 * suggestion / normalizer / global-resolver integration flows.
 *
 * Goes beyond the shallow checks already in flow-org-lifecycle-deep.spec.ts
 * (single create→list→fetch, one `-2` bump, one taken/untaken check-slug,
 * the upgrade 409 guard) and slug-collision.spec.ts (that file is about
 * WORK slugs, not org slugs). This file exercises the multi-step COLLISION
 * CASCADE, the SUGGESTION mechanics, the exact NORMALIZER + its input
 * VALIDATION boundary, the GLOBAL cross-user/cross-tenant slug namespace,
 * and the GLOBAL slug resolver — all PROBED live against the sqlite CI
 * driver on 2026-06-01 before asserting.
 *
 * VERIFIED CONTRACT (apps/api/src/organizations/{organizations.controller,
 * organization.service}.ts, dto/{create,update,check-slug}.dto.ts,
 * apps/api/src/users/services/username-allocator.service.ts,
 * packages/contracts/src/api/organization/index.ts):
 *
 *   POST /api/organizations { name (1..200), slug? (1..64) }
 *     - 201 { id, tenantId, slug, displayName, legalName, countryCode,
 *             registrationProvider, registrationStatus, linkedWorkId,
 *             createdAt, updatedAt }   (NO `name`, NO `ownerId` field)
 *     - slug omitted -> derived from `name` via UsernameAllocatorService.
 *     - COLLISION (explicit OR derived) NEVER 400 -> appends -2, -3, … ;
 *       the numeric suffix STARTS AT 2 (allocateUsername: `suffix=1` then
 *       pre-increments to 2 on the first collision).
 *     - The slug namespace is GLOBAL: collides against users.username (CI),
 *       users.slug AND organizations.slug, ACROSS all users/tenants. There
 *       is NO reserved-word list — `admin`, `api`, `org` are ordinary slugs
 *       (probed: each `available:true`; explicit slug `admin` is taken verbatim).
 *
 *   GET /api/organizations/check-slug?value=<raw>   (PUBLIC + @Throttle 30/60s)
 *     - param is literally `value`. CheckSlugQueryDto: @Length(1,64) +
 *       @Matches(/^[\p{L}\p{N}._@'\- ]+$/u). So:
 *         * missing `value`            -> 400
 *         * empty `value=`             -> 400
 *         * length > 64                -> 400
 *         * contains !, #, &, /, etc.  -> 400 ("value contains unsupported characters…")
 *         * allowed set: unicode letters/digits + dot, underscore, at-sign,
 *           apostrophe, hyphen, space.
 *     - 200 { available, normalized, suggestion? }  (SINGULAR `suggestion`,
 *       plus a `normalized` echo — there is NO `suggestions` array).
 *     - available=true  -> `suggestion` OMITTED (undefined).
 *     - available=false -> `suggestion` = next-free `-N` (== allocateUsername).
 *     - NORMALIZER (UsernameAllocatorService.normalize): lowercase, then
 *       `[^a-z0-9-]+ -> '-'`, collapse `-+ -> '-'`, trim leading/trailing `-`.
 *       It does NOT strip diacritics (no NFKD) — probed: 'Café Münch' ->
 *       'caf-m-nch'. 'Acme Inc' -> 'acme-inc'; "O'Brien Co" -> 'o-brien-co';
 *       'github.user@x.io' -> 'github-user-x-io'.
 *
 *   GET /api/organizations/:slug
 *     - GLOBAL resolver: 200 for ANY authenticated caller (member or not).
 *       Anonymous (no bearer) -> 401. Unknown slug -> 404 { error:'Not Found' }.
 *
 *   PATCH /api/organizations/:id { displayName?, legalName?, countryCode? }
 *     - 200 with the updated org. slug is IMMUTABLE: it is not in the DTO, so
 *       a stray `slug` in the body is REJECTED with 400 "property slug should
 *       not exist" (forbidNonWhitelisted), NOT silently stripped.
 *     - caller with NO Tenant patching any org -> 401 ("User has no Tenant").
 *       caller WITH a Tenant patching an org outside it -> 404 (no leak).
 *
 * Cross-spec isolation: every flow uses FRESH registerUserViaAPI() users with
 * Date.now()+random-suffixed slugs; assertions tolerate pre-existing rows.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sfx = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function checkSlug(request: APIRequestContext, token: string | null, value: string) {
    const headers = token ? authedHeaders(token) : undefined;
    return request.get(
        `${API_BASE}/api/organizations/check-slug?value=${encodeURIComponent(value)}`,
        { headers },
    );
}

function createOrg(
    request: APIRequestContext,
    token: string,
    data: { name: string; slug?: string },
) {
    return request.post(`${API_BASE}/api/organizations`, { headers: authedHeaders(token), data });
}

test.describe('organization slug lifecycle (deep)', () => {
    test('explicit-slug collision cascades -2/-3/-4 and check-slug suggestion tracks the next free suffix', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const base = `cascade-${sfx()}`;

        // First create takes the bare base slug verbatim.
        const r1 = await createOrg(request, user.access_token, { name: 'Cascade One', slug: base });
        expect(r1.status()).toBe(201);
        expect((await r1.json()).slug).toBe(base);

        // Same explicit slug must NEVER 400 — it bumps to -2, then -3.
        const r2 = await createOrg(request, user.access_token, { name: 'Cascade Two', slug: base });
        expect(r2.status()).toBe(201);
        expect((await r2.json()).slug).toBe(`${base}-2`);

        const r3 = await createOrg(request, user.access_token, {
            name: 'Cascade Three',
            slug: base,
        });
        expect(r3.status()).toBe(201);
        expect((await r3.json()).slug).toBe(`${base}-3`);

        // With base, -2, -3 taken, check-slug must report unavailable and
        // suggest the NEXT free suffix (-4).
        const chk = await checkSlug(request, user.access_token, base);
        expect(chk.status()).toBe(200);
        const body = await chk.json();
        expect(body.available).toBe(false);
        expect(body.normalized).toBe(base);
        expect(body.suggestion).toBe(`${base}-4`);
        expect(body.suggestion).toMatch(SLUG_RE);

        // The suggested slug must actually be free + claimable.
        const recheck = await checkSlug(request, user.access_token, body.suggestion);
        const recheckBody = await recheck.json();
        expect(recheckBody.available).toBe(true);
        expect(recheckBody.suggestion).toBeUndefined();

        const claim = await createOrg(request, user.access_token, {
            name: 'Cascade Four',
            slug: base,
        });
        expect(claim.status()).toBe(201);
        expect((await claim.json()).slug).toBe(`${base}-4`);
    });

    test('check-slug value= param: available->no suggestion, taken->suggestion, missing/empty/too-long->400, non-mutating', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const fresh = `freshchk-${sfx()}`;

        // A fresh slug is available and carries NO suggestion field.
        const okRes = await checkSlug(request, user.access_token, fresh);
        expect(okRes.status()).toBe(200);
        const okBody = await okRes.json();
        expect(okBody.available).toBe(true);
        expect(okBody.normalized).toBe(fresh);
        expect(okBody.suggestion).toBeUndefined();

        // check-slug is a pure read: re-checking is still available (no row created).
        const reCheck = await checkSlug(request, user.access_token, fresh);
        expect((await reCheck.json()).available).toBe(true);

        // Missing `value` entirely -> 400 (CheckSlugQueryDto requires it).
        const missing = await request.get(`${API_BASE}/api/organizations/check-slug`, {
            headers: authedHeaders(user.access_token),
        });
        expect(missing.status()).toBe(400);

        // Empty `value=` -> 400 (@Length(1,64)).
        const empty = await request.get(`${API_BASE}/api/organizations/check-slug?value=`, {
            headers: authedHeaders(user.access_token),
        });
        expect(empty.status()).toBe(400);

        // Over the 64-char ceiling -> 400.
        const tooLong = await checkSlug(request, user.access_token, 'a'.repeat(65));
        expect(tooLong.status()).toBe(400);

        // Wrong param name (`slug=`) leaves `value` missing -> 400.
        const wrongParam = await request.get(
            `${API_BASE}/api/organizations/check-slug?slug=${encodeURIComponent(fresh)}`,
            { headers: authedHeaders(user.access_token) },
        );
        expect(wrongParam.status()).toBe(400);

        // After actually creating it, the value flips unavailable WITH a suggestion.
        const created = await createOrg(request, user.access_token, {
            name: 'Fresh Chk',
            slug: fresh,
        });
        expect(created.status()).toBe(201);
        const afterBody = await (await checkSlug(request, user.access_token, fresh)).json();
        expect(afterBody.available).toBe(false);
        expect(afterBody.suggestion).toBe(`${fresh}-2`);
    });

    test('check-slug is PUBLIC, rejects unsupported characters (400), and runs the exact normalizer the create path uses', async ({
        request,
    }) => {
        // No bearer token — check-slug is @Public(). It must still resolve.
        const anonCheck = await checkSlug(request, null, `pub-${sfx()}`);
        expect(anonCheck.status()).toBe(200);
        expect((await anonCheck.json()).available).toBe(true);

        // INPUT VALIDATION boundary: the DTO @Matches allow-set is letters,
        // digits, dot, underscore, at-sign, apostrophe, hyphen, space. Anything
        // else (!, #, &, /) is a 400 BEFORE the normalizer runs.
        for (const bad of ['Bang!', 'Hash#Tag', 'A & B', 'a/b']) {
            const res = await checkSlug(request, null, bad);
            expect(res.status(), `rejected '${bad}'`).toBe(400);
        }

        // NORMALIZER contract (probed live): lowercase + collapse the allowed
        // punctuation/spaces to single '-' + trim. It does NOT strip diacritics.
        const cases: Array<[string, string]> = [
            ['Acme Inc', 'acme-inc'],
            ["O'Brien Co", 'o-brien-co'],
            ['github.user@x.io', 'github-user-x-io'],
            ['  Padded Name  ', 'padded-name'], // leading/trailing trimmed
            ['Café Münch', 'caf-m-nch'], // non-ASCII letters dropped, NOT transliterated
        ];
        for (const [input, expected] of cases) {
            const body = await (await checkSlug(request, null, input)).json();
            expect(body.normalized, `normalize('${input}')`).toBe(expected);
            expect(body.normalized).toMatch(SLUG_RE);
        }

        // The normalizer the CHECK uses MUST match the slug the CREATE allocates:
        // a check-slug preview equals the created org's slug (when free).
        const user = await registerUserViaAPI(request);
        const messy = `Quirk Co ${sfx()}`;
        const preview = (await (await checkSlug(request, user.access_token, messy)).json())
            .normalized as string;
        expect(preview).toMatch(SLUG_RE);
        const created = await createOrg(request, user.access_token, { name: messy });
        expect(created.status()).toBe(201);
        expect((await created.json()).slug).toBe(preview);
    });

    test('no reserved-word list: admin/api/org are ordinary available slugs and are claimable verbatim, then cascade', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);

        // Words a platform OFTEN reserves are NOT special here — probed each as
        // available on a clean namespace. We claim them on a unique-prefixed
        // variant to stay isolation-safe, while still proving there is no
        // special-casing of the bare word itself.
        for (const word of ['admin', 'api', 'org', 'settings', 'dashboard']) {
            // The bare word's availability depends only on prior rows, never on a
            // reserved list: if free it has no suggestion, if taken the suggestion
            // is a plain numeric bump (never suggestion-less the way a reserved
            // word would be).
            const chk = await (await checkSlug(request, user.access_token, word)).json();
            if (chk.available) {
                expect(chk.suggestion, `free '${word}' has no suggestion`).toBeUndefined();
            } else {
                expect(chk.suggestion, `taken '${word}' bumps`).toBe(`${word}-2`);
            }
        }

        // A unique slug that merely STARTS with a reserved-ish word is claimed
        // verbatim — confirming the word carries no special weight.
        const word = `admin-${sfx()}`;
        const first = await createOrg(request, user.access_token, {
            name: 'Admin Like',
            slug: word,
        });
        expect(first.status()).toBe(201);
        expect((await first.json()).slug).toBe(word);

        // And it then cascades like any other slug.
        const second = await createOrg(request, user.access_token, {
            name: 'Admin Like 2',
            slug: word,
        });
        expect(second.status()).toBe(201);
        expect((await second.json()).slug).toBe(`${word}-2`);
    });

    test('slug namespace is GLOBAL across users/tenants: userB colliding with userA cascades; list stays tenant-scoped', async ({
        request,
    }) => {
        const userA = await registerUserViaAPI(request);
        const userB = await registerUserViaAPI(request);
        const base = `shared-${sfx()}`;

        // userA claims the bare base slug.
        const a1 = await createOrg(request, userA.access_token, { name: 'Shared A', slug: base });
        expect(a1.status()).toBe(201);
        expect((await a1.json()).slug).toBe(base);

        // userB (different user, different tenant) requesting the SAME slug does
        // NOT get its own private `base` — it cascades GLOBALLY to -2.
        const b1 = await createOrg(request, userB.access_token, { name: 'Shared B', slug: base });
        expect(b1.status()).toBe(201);
        expect((await b1.json()).slug).toBe(`${base}-2`);

        // userA colliding again jumps over userB's -2 to -3 (single global counter).
        const a2 = await createOrg(request, userA.access_token, { name: 'Shared A2', slug: base });
        expect(a2.status()).toBe(201);
        expect((await a2.json()).slug).toBe(`${base}-3`);

        // check-slug from EITHER user agrees the namespace is shared: base taken,
        // next free is -4.
        const fromA = await (await checkSlug(request, userA.access_token, base)).json();
        const fromB = await (await checkSlug(request, userB.access_token, base)).json();
        expect(fromA.available).toBe(false);
        expect(fromB.available).toBe(false);
        expect(fromA.suggestion).toBe(`${base}-4`);
        expect(fromB.suggestion).toBe(`${base}-4`);

        // Despite the GLOBAL slug namespace, GET /api/organizations stays
        // TENANT-scoped: userA's list has base + base-3 but NEVER userB's base-2.
        const listA = (await (
            await request.get(`${API_BASE}/api/organizations`, {
                headers: authedHeaders(userA.access_token),
            })
        ).json()) as Array<{ slug: string }>;
        const aSlugs = listA.map((o) => o.slug);
        expect(aSlugs).toContain(base);
        expect(aSlugs).toContain(`${base}-3`);
        expect(aSlugs).not.toContain(`${base}-2`);
    });

    test('global slug resolver + immutable slug: cross-user 200, anon 401, unknown 404; PATCH rejects a stray slug (400)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const slug = `resolver-${sfx()}`;

        const created = await createOrg(request, owner.access_token, {
            name: 'Resolver Org',
            slug,
        });
        expect(created.status()).toBe(201);
        const org = await created.json();
        expect(org.slug).toBe(slug);

        // GLOBAL resolver: the owner resolves it…
        const byOwner = await request.get(`${API_BASE}/api/organizations/${slug}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(byOwner.status()).toBe(200);
        expect((await byOwner.json()).id).toBe(org.id);

        // …and so does a NON-MEMBER stranger (resolver is global, not membership-scoped).
        const byStranger = await request.get(`${API_BASE}/api/organizations/${slug}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(byStranger.status()).toBe(200);
        expect((await byStranger.json()).id).toBe(org.id);

        // Anonymous (no bearer) -> rejected; only check-slug is @Public().
        const anon = await request.get(`${API_BASE}/api/organizations/${slug}`);
        expect([401, 403]).toContain(anon.status());

        // Unknown slug -> 404 for any authed caller.
        const unknown = await request.get(`${API_BASE}/api/organizations/nope-${sfx()}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(unknown.status()).toBe(404);

        // PATCH can change displayName…
        const okPatch = await request.patch(`${API_BASE}/api/organizations/${org.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { displayName: 'Renamed Resolver' },
        });
        expect(okPatch.status()).toBe(200);
        const patched = await okPatch.json();
        expect(patched.displayName).toBe('Renamed Resolver');
        expect(patched.slug).toBe(slug); // slug untouched

        // …but the slug is IMMUTABLE — it is not in UpdateOrganizationDto, so a
        // stray `slug` in the body is REJECTED (forbidNonWhitelisted), NOT stripped.
        const hijack = await request.patch(`${API_BASE}/api/organizations/${org.id}`, {
            headers: authedHeaders(owner.access_token),
            data: { slug: `hijack-${sfx()}` },
        });
        expect(hijack.status()).toBe(400);
        expect(JSON.stringify(await hijack.json())).toContain('slug');

        // The original slug still resolves unchanged.
        const stillThere = await request.get(`${API_BASE}/api/organizations/${slug}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(stillThere.status()).toBe(200);

        // A caller OUTSIDE the org's tenant cannot PATCH it. The stranger has no
        // Tenant of their own yet -> 401 ("User has no Tenant"); once they own a
        // Tenant, the same PATCH 404s (the org isn't theirs, existence not leaked).
        const noTenantPatch = await request.patch(`${API_BASE}/api/organizations/${org.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { displayName: 'Hacked' },
        });
        expect([401, 403]).toContain(noTenantPatch.status());

        await createOrg(request, stranger.access_token, { name: 'Stranger Own Org' }); // gives stranger a Tenant
        const withTenantPatch = await request.patch(`${API_BASE}/api/organizations/${org.id}`, {
            headers: authedHeaders(stranger.access_token),
            data: { displayName: 'Hacked Again' },
        });
        expect(withTenantPatch.status()).toBe(404);

        // Owner's org is untouched by either failed cross-tenant attempt.
        const final = await request.get(`${API_BASE}/api/organizations/${slug}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect((await final.json()).displayName).toBe('Renamed Resolver');
    });
});
