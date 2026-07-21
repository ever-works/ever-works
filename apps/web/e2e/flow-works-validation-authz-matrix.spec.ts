/**
 * Works create / update — EXHAUSTIVE validation + authz MATRIX.
 *
 * This file is the field-by-field validation + authorization matrix for the
 * PRIMARY Work lifecycle endpoints:
 *
 *   POST  /api/works          (CreateWorkDto)
 *   PATCH /api/works/:id       (UpdateWorkDto — thin alias of PUT)
 *   PUT   /api/works/:id       (UpdateWorkDto)
 *   POST  /api/works/:id/delete
 *   GET   /api/works/:id
 *   GET   /api/works/check-slug
 *
 * It deliberately does NOT duplicate the existing works specs, which cover
 * DIFFERENT angles:
 *   • flow-works-crud-meta-deep       → the META sub-readers (config / count /
 *     categories-tags / history / website-settings / source-validation) + the
 *     quick-create provider gate; explicitly defers the works/:id PRIMARY guards.
 *   • flow-work-rename-slug-collision → the rename FLOW + slug-collision race.
 *   • flow-register-work-deep         → the ONBOARDING RegisterWorkDto (repo /
 *     agentId / subdomain / webhookUrl) — a wholly different DTO.
 * THIS file is the exhaustive per-DTO-field validation grid + the works/:id
 * PRIMARY authz + id-edge grid, which none of the above provide.
 *
 * ── Verified contract (probed LIVE against http://127.0.0.1:3100, sqlite
 *    in-memory — the same driver CI uses — before any assertion was written):
 *
 *   Envelopes:
 *     Success            → 200 { status:'success', work:{ id (uuid), slug, name,
 *                          description, organization, kind, userId, … } }.
 *                          NOTE: create returns 200 (@HttpCode OK), never 201.
 *     DTO validation err → 400 { message:[…strings], error:'Bad Request',
 *                          statusCode:400 }   (message is an ARRAY; validators
 *                          do NOT fail-fast — every failing rule on a field is
 *                          listed at once).
 *     Service business   → { status:'error', message:'<string>' } (message is a
 *                          STRING) with a semantic code:
 *                            409-ish "Work already exists"        → 400
 *                            "Work with id '…' not found"          → 404
 *                            "You do not have permission …"        → 403
 *                            "Unsupported website template: …"     → 400
 *                            "Organization not found"              → 404
 *     Auth missing       → 401 { message:'Unauthorized', statusCode:401 }.
 *
 *   CreateWorkDto (global ValidationPipe: whitelist + forbidNonWhitelisted +
 *   transform):
 *     slug        REQUIRED string, @IsNotEmpty, @Matches /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
 *                 Transform trim+lowercase. Missing/empty/whitespace/bad-format/
 *                 non-string → 400. 'MixedCase' → normalized lowercase → 200.
 *     name        REQUIRED string, @IsNotEmpty, @MaxLength(100) but a sanitize
 *                 Transform TRUNCATES to 100 FIRST → an over-long name is NOT a
 *                 400, it is silently truncated to 100. Missing/empty/non-string → 400.
 *     description REQUIRED string, @IsNotEmpty, @MaxLength(500) — same sanitize-
 *                 then-truncate semantics as name (600 chars → 200, len 500).
 *     organization REQUIRED boolean (no @IsOptional) → missing / 'yes' / null → 400.
 *     owner       OPTIONAL string (non-string → 400).
 *     gitProvider OPTIONAL string default 'github' (non-string → 400; arbitrary
 *                 string accepted, lowercased). deployProvider / storageProvider
 *                 OPTIONAL free strings (lowercased, accepted).
 *     kind        OPTIONAL; normalizeCreateWorkKind COERCES any unknown/alias/
 *                 non-string to 'default' BEFORE @IsIn — so 'banana' AND 123 both
 *                 succeed with kind:'default'; 'blog' persists as 'blog'.
 *     websiteTemplateId OPTIONAL string — 'classic' accepted; an UNKNOWN id is
 *                 rejected at the SERVICE layer → 400 "Unsupported website template".
 *     readmeConfig OPTIONAL @ValidateNested — a non-boolean nested flag →
 *                 400 "readmeConfig.overwriteDefaultHeader must be a boolean value".
 *     correlationId OPTIONAL string (non-string → 400).
 *     Unknown top-level property → 400 "property <x> should not exist".
 *     Duplicate slug (same user) → 400 { status:'error', message:'Work already exists' }.
 *
 *   UpdateWorkDto (all OPTIONAL — empty {} is a valid 200 no-op):
 *     slug is NOT a member → PATCH {slug} → 400 "property slug should not exist".
 *     name/description → sanitize-then-truncate (over-length → 200, not 400);
 *       non-string → 400. committerName @MaxLength(120) sanitize-truncates to 120.
 *     committerEmail @IsEmail → 'notanemail' → 400; valid → 200 echo.
 *     activitySyncMode @IsIn(pull|push|disabled) → 'bogus' → 400; 'disabled' → 200 echo.
 *     communityPrEnabled @IsBoolean → 'yes' → 400; true → 200 echo.
 *     organizationId @IsUUID → 'not-a-uuid' → 400; a well-formed but foreign/
 *       unknown uuid → 404 "Organization not found" (service existence check);
 *       null CLEARS the membership → 200.
 *     Unknown property → 400 forbidNonWhitelisted.
 *
 *   Authz + id edges (works/:id PRIMARY guard — access checked BEFORE existence,
 *   so a stranger hitting an EXISTING work is 403, NOT a 404 existence-hide):
 *     GET/PATCH/DELETE own → 200 ; cross-user → 403 "You do not have permission
 *       to access this work" ; no bearer → 401.
 *     Owner + unknown well-formed uuid → 404 "Work with id '…' not found".
 *     Owner + MALFORMED id ('not-a-uuid') → ALSO 404 (there is NO ParseUUIDPipe
 *       on works/:id — the raw string flows to the service lookup) — never a 400.
 *     DELETE is POST /api/works/:id/delete (not a REST DELETE verb).
 *
 *   check-slug: GET /api/works/check-slug?slug=… → 200 { available, slug,
 *     suggestion? } ; missing/empty slug → 400 "Missing required `slug` query
 *     parameter" ; no bearer → 401.
 *
 * ── Discipline: every test registers FRESH registerUserViaAPI() users (never
 *    the shared seeded user). Ids asserted via toMatch(UUID_RE); no exact global
 *    counts. Unique suffixes via Date.now()+random. `flow-` prefix keeps this out
 *    of the no-auth testIgnore set; fully API-orchestrated (no UI/stack contention).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const BASE = `${API_BASE}/api`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const MALFORMED_ID = 'not-a-uuid';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A minimally-valid CreateWorkDto body, with optional field overrides. */
function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        slug: `w-${stamp()}`,
        name: 'Matrix Work',
        description: 'matrix work description',
        organization: false,
        ...extra,
    };
}

async function postWork(request: APIRequestContext, token: string, data: unknown) {
    return request.post(`${BASE}/works`, { headers: authedHeaders(token), data });
}

async function patchWork(request: APIRequestContext, token: string, id: string, data: unknown) {
    return request.patch(`${BASE}/works/${id}`, { headers: authedHeaders(token), data });
}

/** Assert the class-validator 400 envelope (message is an ARRAY). */
async function expectDtoError(
    res: { status(): number; json(): Promise<unknown>; text(): Promise<string> },
    contains?: string,
): Promise<void> {
    const txt = await res.text();
    expect(res.status(), `expected DTO 400, got ${res.status()} :: ${txt}`).toBe(400);
    const body = JSON.parse(txt) as { message: unknown; error: string; statusCode: number };
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(Array.isArray(body.message)).toBe(true);
    if (contains) {
        expect((body.message as string[]).join(' | ')).toContain(contains);
    }
}

/** Assert the service business-error envelope { status:'error', message:string }. */
async function expectServiceError(
    res: { status(): number; text(): Promise<string> },
    expectedStatus: number,
    contains?: string,
): Promise<void> {
    const txt = await res.text();
    expect(res.status(), `expected service ${expectedStatus}, got ${res.status()} :: ${txt}`).toBe(
        expectedStatus,
    );
    const body = JSON.parse(txt) as { status?: string; message?: unknown };
    expect(body.status).toBe('error');
    if (contains) {
        expect(String(body.message)).toContain(contains);
    }
}

/** Register a fresh user + a valid Work; returns the owner token + work id. */
async function makeOwnedWork(
    request: APIRequestContext,
): Promise<{
    user: Awaited<ReturnType<typeof registerUserViaAPI>>;
    token: string;
    workId: string;
}> {
    const user = await registerUserViaAPI(request);
    const res = await postWork(request, user.access_token, base());
    expect(res.status(), `setup create failed: ${await res.text()}`).toBe(200);
    const body = (await res.json()) as { work: { id: string } };
    expect(body.work.id).toMatch(UUID_RE);
    return { user, token: user.access_token, workId: body.work.id };
}

// ───────────────────────────── CREATE — slug ─────────────────────────────

test('POST /works happy path → 200 success envelope with normalized slug + default kind', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const slug = `happy-${stamp()}`;
    const res = await postWork(request, user.access_token, base({ slug, organization: true }));
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as {
        status: string;
        work: {
            id: string;
            slug: string;
            name: string;
            description: string;
            organization: boolean;
            kind: string;
            userId: string;
        };
    };
    expect(body.status).toBe('success');
    expect(body.work.id).toMatch(UUID_RE);
    expect(body.work.slug).toBe(slug); // already lowercase, unchanged
    expect(body.work.name).toBe('Matrix Work');
    expect(body.work.organization).toBe(true);
    expect(body.work.kind).toBe('default'); // omitted kind → column default
    expect(body.work.userId).toBe(user.user.id);
});

test('POST /works slug matrix: missing / empty / whitespace / bad-format / non-string all → 400 DTO', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const missing = base();
    delete missing.slug;
    await expectDtoError(await postWork(request, tok, missing), 'slug');

    await expectDtoError(await postWork(request, tok, base({ slug: '' })), 'should not be empty');
    await expectDtoError(await postWork(request, tok, base({ slug: '   ' })), 'lowercase');
    await expectDtoError(await postWork(request, tok, base({ slug: 'Bad_Slug!' })), 'lowercase');
    await expectDtoError(await postWork(request, tok, base({ slug: '-lead' })), 'lowercase');
    await expectDtoError(await postWork(request, tok, base({ slug: 'trail-' })), 'lowercase');
    await expectDtoError(await postWork(request, tok, base({ slug: 'a--b' })), 'lowercase');
    await expectDtoError(
        await postWork(request, tok, base({ slug: 123 })),
        'slug must be a string',
    );
});

test('POST /works normalizes a mixed-case slug to lowercase → 200', async ({ request }) => {
    const user = await registerUserViaAPI(request);
    const suffix = stamp();
    const res = await postWork(request, user.access_token, base({ slug: `MixedCase-${suffix}` }));
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { work: { slug: string } };
    expect(body.work.slug).toBe(`mixedcase-${suffix}`);
});

test('POST /works duplicate slug for the same user → 400 service "Work already exists"', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;
    const slug = `dup-${stamp()}`;
    const first = await postWork(request, tok, base({ slug }));
    expect(first.status(), await first.text()).toBe(200);
    const second = await postWork(request, tok, base({ slug, name: 'Second' }));
    await expectServiceError(second, 400, 'already exists');
});

// ───────────────────────────── CREATE — name ─────────────────────────────

test('POST /works name matrix: missing / empty / non-string → 400 DTO', async ({ request }) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const missing = base();
    delete missing.name;
    await expectDtoError(await postWork(request, tok, missing), 'name must be a string');

    await expectDtoError(
        await postWork(request, tok, base({ name: '' })),
        'name should not be empty',
    );
    await expectDtoError(await postWork(request, tok, base({ name: 42 })), 'name must be a string');
});

test('POST /works over-length name is sanitize-TRUNCATED to 100 (not a 400) → 200', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const res = await postWork(request, user.access_token, base({ name: 'x'.repeat(150) }));
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { work: { name: string } };
    expect(body.work.name.length).toBe(100);
});

// ─────────────────────────── CREATE — description ─────────────────────────

test('POST /works description matrix: missing / empty / non-string → 400 DTO', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const missing = base();
    delete missing.description;
    await expectDtoError(await postWork(request, tok, missing), 'description must be a string');

    await expectDtoError(
        await postWork(request, tok, base({ description: '' })),
        'description should not be empty',
    );
    await expectDtoError(
        await postWork(request, tok, base({ description: true })),
        'description must be a string',
    );
});

test('POST /works over-length description is sanitize-TRUNCATED to 500 (not a 400) → 200', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const res = await postWork(request, user.access_token, base({ description: 'y'.repeat(600) }));
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { work: { description: string } };
    expect(body.work.description.length).toBe(500);
});

// ─────────────────────────── CREATE — organization ───────────────────────

test('POST /works organization is a REQUIRED boolean: missing / string / null → 400; true & false accepted', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const missing = base();
    delete missing.organization;
    await expectDtoError(
        await postWork(request, tok, missing),
        'organization must be a boolean value',
    );
    await expectDtoError(
        await postWork(request, tok, base({ organization: 'yes' })),
        'organization must be a boolean value',
    );
    await expectDtoError(
        await postWork(request, tok, base({ organization: null })),
        'organization must be a boolean value',
    );

    const ok = await postWork(request, tok, base({ organization: true }));
    expect(ok.status(), await ok.text()).toBe(200);
    expect(((await ok.json()) as { work: { organization: boolean } }).work.organization).toBe(true);
});

// ─────────────────────── CREATE — owner + providers ──────────────────────

test('POST /works owner must be a string when present; a valid owner is echoed', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    await expectDtoError(
        await postWork(request, tok, base({ owner: 123 })),
        'owner must be a string',
    );

    const ok = await postWork(request, tok, base({ owner: 'some-org' }));
    expect(ok.status(), await ok.text()).toBe(200);
    expect(((await ok.json()) as { work: { owner: string } }).work.owner).toBe('some-org');
});

test('POST /works provider fields: non-string gitProvider → 400; arbitrary git/deploy/storage strings accepted + lowercased', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    await expectDtoError(
        await postWork(request, tok, base({ gitProvider: 123 })),
        'gitProvider must be a string',
    );

    // These fields are free strings at the DTO layer (not enum-validated) —
    // they are accepted and lowercased. (websiteTemplateId is intentionally
    // omitted here; it has a SEPARATE service-level check, asserted elsewhere.)
    const ok = await postWork(
        request,
        tok,
        base({ gitProvider: 'MADEUP', deployProvider: 'Whatever', storageProvider: 'NoPe' }),
    );
    expect(ok.status(), await ok.text()).toBe(200);
    const w = ((await ok.json()) as { work: { gitProvider: string; deployProvider: string } }).work;
    expect(w.gitProvider).toBe('madeup');
    expect(w.deployProvider).toBe('whatever');
});

// ───────────────────────────── CREATE — kind ─────────────────────────────

test('POST /works kind is COERCED: unknown string and non-string both → "default"; a valid kind persists', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const unknown = await postWork(request, tok, base({ kind: 'banana' }));
    expect(unknown.status(), await unknown.text()).toBe(200);
    expect(((await unknown.json()) as { work: { kind: string } }).work.kind).toBe('default');

    const numeric = await postWork(request, tok, base({ kind: 123 }));
    expect(numeric.status(), await numeric.text()).toBe(200);
    expect(((await numeric.json()) as { work: { kind: string } }).work.kind).toBe('default');

    const blog = await postWork(request, tok, base({ kind: 'blog' }));
    expect(blog.status(), await blog.text()).toBe(200);
    expect(((await blog.json()) as { work: { kind: string } }).work.kind).toBe('blog');
});

// ──────────────────────── CREATE — websiteTemplateId ─────────────────────

test('POST /works websiteTemplateId: "classic" accepted; an unknown id → 400 service "Unsupported website template"', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const good = await postWork(request, tok, base({ websiteTemplateId: 'classic' }));
    expect(good.status(), await good.text()).toBe(200);

    const bad = await postWork(request, tok, base({ websiteTemplateId: 'zzz-nope' }));
    await expectServiceError(bad, 400, 'Unsupported website template');
});

// ─────────────────────────── CREATE — readmeConfig ───────────────────────

test('POST /works readmeConfig is validated nested: bad boolean flag → 400 with dotted path; a valid config is echoed', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    await expectDtoError(
        await postWork(request, tok, base({ readmeConfig: { overwriteDefaultHeader: 'yes' } })),
        'readmeConfig.overwriteDefaultHeader must be a boolean value',
    );

    const ok = await postWork(
        request,
        tok,
        base({ readmeConfig: { header: 'hello', overwriteDefaultHeader: true } }),
    );
    expect(ok.status(), await ok.text()).toBe(200);
    const cfg = (
        (await ok.json()) as { work: { readmeConfig: { overwriteDefaultHeader: boolean } } }
    ).work.readmeConfig;
    expect(cfg.overwriteDefaultHeader).toBe(true);
});

// ──────────────────── CREATE — correlationId + closed shape ───────────────

test('POST /works is a CLOSED shape: non-string correlationId → 400; an unknown top-level property → 400 forbidNonWhitelisted', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    await expectDtoError(
        await postWork(request, tok, base({ correlationId: 123 })),
        'correlationId must be a string',
    );
    await expectDtoError(
        await postWork(request, tok, base({ hackerField: 'x' })),
        'property hackerField should not exist',
    );
});

// ───────────────────────────── CREATE — auth ─────────────────────────────

test('POST /works with no bearer → 401', async ({ request }) => {
    const res = await request.post(`${BASE}/works`, { data: base() });
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(401);
    expect(body.message).toBe('Unauthorized');
});

// ───────────────────────────── UPDATE — happy ────────────────────────────

test('PATCH & PUT /works/:id own valid update → 200; the rename is echoed', async ({ request }) => {
    const { token, workId } = await makeOwnedWork(request);

    const patched = await patchWork(request, token, workId, { name: 'Renamed via PATCH' });
    expect(patched.status(), await patched.text()).toBe(200);
    expect(((await patched.json()) as { work: { name: string } }).work.name).toBe(
        'Renamed via PATCH',
    );

    const put = await request.put(`${BASE}/works/${workId}`, {
        headers: authedHeaders(token),
        data: { description: 'Updated via PUT' },
    });
    expect(put.status(), await put.text()).toBe(200);
    expect(((await put.json()) as { work: { description: string } }).work.description).toBe(
        'Updated via PUT',
    );
});

test('PATCH /works/:id with an empty body {} is a valid 200 no-op (all UpdateWorkDto fields optional)', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    const res = await patchWork(request, token, workId, {});
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('success');
});

test('PATCH /works/:id is a CLOSED shape: "slug" is not updatable and unknown props are rejected → 400', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    await expectDtoError(
        await patchWork(request, token, workId, { slug: 'new-slug' }),
        'property slug should not exist',
    );
    await expectDtoError(
        await patchWork(request, token, workId, { nope: 1 }),
        'property nope should not exist',
    );
});

// ─────────────────────── UPDATE — per-field validation ────────────────────

test('PATCH /works/:id name: non-string → 400; over-length is sanitize-truncated to 100 → 200', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    await expectDtoError(
        await patchWork(request, token, workId, { name: 123 }),
        'name must be a string',
    );
    const trunc = await patchWork(request, token, workId, { name: 'q'.repeat(150) });
    expect(trunc.status(), await trunc.text()).toBe(200);
    expect(((await trunc.json()) as { work: { name: string } }).work.name.length).toBe(100);
});

test('PATCH /works/:id committerEmail: invalid → 400; a valid email → 200 echo', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    await expectDtoError(
        await patchWork(request, token, workId, { committerEmail: 'notanemail' }),
        'committerEmail must be an email',
    );
    const ok = await patchWork(request, token, workId, { committerEmail: 'dev@example.com' });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(((await ok.json()) as { work: { committerEmail: string } }).work.committerEmail).toBe(
        'dev@example.com',
    );
});

test('PATCH /works/:id committerName over 120 chars is sanitize-truncated to 120 → 200', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    const res = await patchWork(request, token, workId, { committerName: 'z'.repeat(150) });
    expect(res.status(), await res.text()).toBe(200);
    const name = ((await res.json()) as { work: { committerName: string } }).work.committerName;
    expect(name.length).toBe(120);
});

test('PATCH /works/:id activitySyncMode: out-of-enum → 400; a valid "disabled" → 200 echo', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    await expectDtoError(
        await patchWork(request, token, workId, { activitySyncMode: 'bogus' }),
        'activitySyncMode must be one of the following values: pull, push, disabled',
    );
    const ok = await patchWork(request, token, workId, { activitySyncMode: 'disabled' });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(
        ((await ok.json()) as { work: { activitySyncMode: string } }).work.activitySyncMode,
    ).toBe('disabled');
});

test('PATCH /works/:id communityPrEnabled: non-boolean → 400; true → 200 echo', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    await expectDtoError(
        await patchWork(request, token, workId, { communityPrEnabled: 'yes' }),
        'communityPrEnabled must be a boolean value',
    );
    const ok = await patchWork(request, token, workId, { communityPrEnabled: true });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(
        ((await ok.json()) as { work: { communityPrEnabled: boolean } }).work.communityPrEnabled,
    ).toBe(true);
});

test('PATCH /works/:id organizationId: malformed uuid → 400 DTO; foreign well-formed uuid → 404 service; null clears → 200', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);

    await expectDtoError(
        await patchWork(request, token, workId, { organizationId: 'not-a-uuid' }),
        'organizationId must be a UUID',
    );

    // Well-formed but unknown/foreign org id → the service existence check fires
    // (input-shape hardening is DTO-level; org membership is service-level).
    await expectServiceError(
        await patchWork(request, token, workId, { organizationId: UNKNOWN_UUID }),
        404,
        'Organization not found',
    );

    const clear = await patchWork(request, token, workId, { organizationId: null });
    expect(clear.status(), await clear.text()).toBe(200);
});

// ─────────────────────── AUTHZ + ID EDGES (works/:id) ─────────────────────

test('GET /works/:id: owner → 200; cross-user → 403 (access before existence); no bearer → 401', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    const stranger = await registerUserViaAPI(request);

    const own = await request.get(`${BASE}/works/${workId}`, { headers: authedHeaders(token) });
    expect(own.status(), await own.text()).toBe(200);
    expect(((await own.json()) as { work: { id: string } }).work.id).toBe(workId);

    const cross = await request.get(`${BASE}/works/${workId}`, {
        headers: authedHeaders(stranger.access_token),
    });
    await expectServiceError(cross, 403, 'do not have permission');

    const anon = await request.get(`${BASE}/works/${workId}`);
    expect(anon.status()).toBe(401);
});

test('GET /works/:id id edges: unknown well-formed uuid → 404; MALFORMED id → 404 too (no ParseUUIDPipe, never a 400)', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    await expectServiceError(
        await request.get(`${BASE}/works/${UNKNOWN_UUID}`, { headers: authedHeaders(tok) }),
        404,
        'not found',
    );
    const malformed = await request.get(`${BASE}/works/${MALFORMED_ID}`, {
        headers: authedHeaders(tok),
    });
    // The raw string reaches the service lookup → 404 (NOT a 400 pipe rejection).
    await expectServiceError(malformed, 404, 'not found');
});

test('PATCH /works/:id: cross-user → 403; no bearer → 401; owner + unknown uuid → 404', async ({
    request,
}) => {
    const { token, workId } = await makeOwnedWork(request);
    const stranger = await registerUserViaAPI(request);

    const cross = await patchWork(request, stranger.access_token, workId, { name: 'hijack' });
    await expectServiceError(cross, 403, 'do not have permission');

    const anon = await request.patch(`${BASE}/works/${workId}`, { data: { name: 'x' } });
    expect(anon.status()).toBe(401);

    const missing = await patchWork(request, token, UNKNOWN_UUID, { name: 'x' });
    await expectServiceError(missing, 404, 'not found');
});

test('POST /works/:id/delete: cross-user → 403; no bearer → 401', async ({ request }) => {
    const { workId } = await makeOwnedWork(request);
    const stranger = await registerUserViaAPI(request);

    const cross = await request.post(`${BASE}/works/${workId}/delete`, {
        headers: authedHeaders(stranger.access_token),
        data: {},
    });
    await expectServiceError(cross, 403, 'do not have permission');

    const anon = await request.post(`${BASE}/works/${workId}/delete`, { data: {} });
    expect(anon.status()).toBe(401);
});

// ─────────────────────────── check-slug (create form) ─────────────────────

test('GET /works/check-slug: valid slug → 200 availability; missing/empty → 400; no bearer → 401', async ({
    request,
}) => {
    const user = await registerUserViaAPI(request);
    const tok = user.access_token;

    const ok = await request.get(`${BASE}/works/check-slug?slug=fresh-${stamp()}`, {
        headers: authedHeaders(tok),
    });
    expect(ok.status(), await ok.text()).toBe(200);
    const body = (await ok.json()) as { available: boolean; slug: string };
    expect(body.available).toBe(true);
    expect(typeof body.slug).toBe('string');

    // NOTE: this endpoint's 400 is a hand-thrown BadRequestException whose
    // `message` is a STRING (not the class-validator array), so we assert the
    // status + string message directly rather than via expectDtoError.
    for (const url of [`${BASE}/works/check-slug`, `${BASE}/works/check-slug?slug=`]) {
        const res = await request.get(url, { headers: authedHeaders(tok) });
        expect(res.status(), await res.text()).toBe(400);
        const eb = (await res.json()) as { message: string; error: string; statusCode: number };
        expect(eb.statusCode).toBe(400);
        expect(eb.error).toBe('Bad Request');
        expect(String(eb.message)).toContain('slug');
    }

    const anon = await request.get(`${BASE}/works/check-slug?slug=x`);
    expect(anon.status()).toBe(401);
});
