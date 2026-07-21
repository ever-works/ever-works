import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Skills + Skill-bindings — EXHAUSTIVE per-field VALIDATION + AUTHZ MATRIX.
 *
 * Theme (POST/PATCH /api/skills, POST /api/skills/:id/bindings,
 * DELETE /api/skill-bindings/:id): one focused assertion cluster PER DTO
 * field, pinned to the exact status codes + error shapes probed against the
 * LIVE stack (sqlite in-memory — the CI driver). This is deliberately the
 * fine-grained field-isolated matrix + the exact-sha256 contentHash proof,
 * NOT the combined-cluster validation or the happy-path CRUD that the
 * neighbouring specs already own:
 *   - flow-skill-crud-scoping / flow-skills-versioning-bindings-multistep /
 *     skills.spec.ts: combined "required-field/oversize 400" clusters,
 *     slug-conflict 409, catalog install, list paging.
 *   - flow-skill-bindings-deep / flow-skill-agent-binding-deep /
 *     flow-skill-binding-permission / sec-pin-skills-scoping: the per-skill
 *     bindings-list lifecycle, the agent RESOLVER projection, and the
 *     security non-disclosure tri-state.
 * This file drills each individual field to its boundary and pins the
 * enum-accepted-then-scope-gated ordering, the exact server-derived
 * contentHash, and the uniform anon/malformed/unknown/cross-user surface.
 *
 * ── Probed contract (verified before every assertion) ────────────────────
 * CreateSkillDto:
 *   ownerType   IsEnum(tenant|mission|idea|work|agent)  missing/invalid/type → 400
 *   ownerId     IsUUID                                   missing/non-uuid/empty → 400
 *   title       IsString MinLength 1 MaxLength 200       empty/>200/type → 400; ==200 → 201
 *   description IsString MinLength 1 MaxLength 1000      empty/>1000/type → 400; ==1000 → 201
 *   instructionsMd IsString MaxLength 65536 (NO min)     type → 400; '' → 201; ==65536 → 201; >65536 → 400
 *   frontmatter IsObject (optional)                      string/array/number → 400; omitted → server default
 *   slug        Matches /^[a-z0-9-]{1,80}$/ (optional)   upper/underscore/space/''/>80 → 400; ==80 & -hyphen- → 201
 *   version     IsString MaxLength 40 (optional, NO min) >40/type → 400; '' & free-form → 201 (stored verbatim)
 *   extra field → 400 forbidNonWhitelisted ("property X should not exist")
 * Scope gate (service, AFTER DTO): tenant.ownerId!=self → 404 "Skill target not found.";
 *   agent/work/idea/mission owner with a non-owned uuid → 404 (same body).
 * contentHash = sha256(instructionsMd) exactly; recomputed on body PATCH, inert on metadata PATCH.
 * UpdateSkillDto: same field bounds; ownerType/ownerId/slug NOT whitelisted → 400; {} → 200 (no-op).
 * CreateSkillBindingDto:
 *   targetType IsEnum(agent|work|mission|idea|tenant)    missing/invalid/type → 400
 *   targetId   IsUUID (ValidateIf !== null)              non-tenant w/o targetId → 400 (service);
 *              non-uuid → 400; null+tenant → 201; tenant+supplied-id → 201 (server nulls it)
 *   priority   IsInt Min 1 Max 1000 (default 100)        0/1001/float → 400; 1 & 1000 → 201
 *   injectIntoAgent/injectIntoGenerator IsBoolean        non-bool → 400 (defaults true/false)
 * Authz: whole write surface demands a bearer (anon → 401); ParseUUIDPipe → 400
 *   "Validation failed (uuid is expected)"; unknown uuid → 404; cross-user → 404 (never 403).
 */

const SKILLS = `${API_BASE}/api/skills`;

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function sha256(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface SkillBody {
    ownerType?: unknown;
    ownerId?: unknown;
    title?: unknown;
    description?: unknown;
    instructionsMd?: unknown;
    frontmatter?: unknown;
    slug?: unknown;
    version?: unknown;
    [k: string]: unknown;
}

/** POST a skill, returning the raw response so the caller pins the status. */
async function postSkill(
    request: APIRequestContext,
    token: string,
    ownerId: string,
    overrides: SkillBody = {},
) {
    return request.post(SKILLS, {
        headers: authedHeaders(token),
        data: {
            ownerType: 'tenant',
            ownerId,
            title: `Skill ${uniq()}`,
            description: 'baseline description',
            instructionsMd: '# baseline body',
            slug: `sk-${uniq()}`,
            ...overrides,
        },
    });
}

/** Create a tenant-scoped skill and assert 201, returning the parsed row. */
async function createSkillOk(
    request: APIRequestContext,
    token: string,
    ownerId: string,
    overrides: SkillBody = {},
): Promise<Record<string, unknown>> {
    const res = await postSkill(request, token, ownerId, overrides);
    expect(res.status(), `createSkillOk body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function postBinding(
    request: APIRequestContext,
    token: string,
    skillId: string,
    data: Record<string, unknown>,
) {
    return request.post(`${SKILLS}/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data,
    });
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE — per-field validation matrix
// ─────────────────────────────────────────────────────────────────────────

test('CreateSkill ownerType: enum is required + validated, and all 5 valid values pass the DTO (scope gate runs AFTER)', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    // missing → 400
    const missing = await postSkill(request, a.access_token, a.user.id, { ownerType: undefined });
    expect(missing.status()).toBe(400);

    // invalid enum value → 400 with the canonical class-validator message
    const bad = await postSkill(request, a.access_token, a.user.id, { ownerType: 'banana' });
    expect(bad.status()).toBe(400);
    const badBody = await bad.json();
    expect(JSON.stringify(badBody.message)).toContain(
        'ownerType must be one of the following values',
    );

    // wrong type (number) → 400
    expect((await postSkill(request, a.access_token, a.user.id, { ownerType: 7 })).status()).toBe(
        400,
    );

    // tenant with self ownerId → 201 (the only fully-owned scope for a fresh user)
    const tenant = await postSkill(request, a.access_token, a.user.id, {
        ownerType: 'tenant',
        slug: `ot-${uniq()}`,
    });
    expect(tenant.status()).toBe(201);

    // agent/work/idea/mission all PASS the enum, then hit the ownership scope gate → 404
    for (const ownerType of ['agent', 'work', 'idea', 'mission'] as const) {
        const res = await postSkill(request, a.access_token, randomUUID(), {
            ownerType,
            slug: `os-${uniq()}`,
        });
        expect(res.status(), `ownerType=${ownerType} should scope-gate to 404`).toBe(404);
        expect((await res.json()).message).toBe('Skill target not found.');
    }
});

test('CreateSkill ownerId: IsUUID — missing / non-uuid / empty / number → 400; well-formed-but-foreign → 404 scope', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    expect(
        (await postSkill(request, a.access_token, a.user.id, { ownerId: undefined })).status(),
    ).toBe(400);

    const nonUuid = await postSkill(request, a.access_token, 'not-a-uuid');
    expect(nonUuid.status()).toBe(400);
    expect(JSON.stringify((await nonUuid.json()).message)).toContain('ownerId must be a UUID');

    expect((await postSkill(request, a.access_token, '')).status()).toBe(400);
    expect(
        (
            await request.post(SKILLS, {
                headers: authedHeaders(a.access_token),
                data: {
                    ownerType: 'tenant',
                    ownerId: 12345,
                    title: 't',
                    description: 'd',
                    instructionsMd: 'b',
                },
            })
        ).status(),
    ).toBe(400);

    // A syntactically-valid uuid that is NOT the caller's own tenant id is a
    // scope failure (404), NOT a DTO failure — proving the uuid check passed.
    const foreign = await postSkill(request, a.access_token, randomUUID(), { ownerType: 'tenant' });
    expect(foreign.status()).toBe(404);
    expect((await foreign.json()).message).toBe('Skill target not found.');
});

test('CreateSkill title: MinLength 1 / MaxLength 200 / string — empty, whitespace-only, >200 and non-string all 400; ==200 → 201', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    expect(
        (await postSkill(request, a.access_token, a.user.id, { title: undefined })).status(),
    ).toBe(400);
    expect((await postSkill(request, a.access_token, a.user.id, { title: '' })).status()).toBe(400);

    // whitespace-only passes MinLength but slugifies to empty → 400 with the
    // service's alphanumeric message (only when no explicit slug is supplied)
    const ws = await postSkill(request, a.access_token, a.user.id, {
        title: '    ',
        slug: undefined,
    });
    expect(ws.status()).toBe(400);
    expect((await ws.json()).message).toBe(
        'Skill title must contain at least one alphanumeric character.',
    );

    expect(
        (await postSkill(request, a.access_token, a.user.id, { title: 'a'.repeat(201) })).status(),
    ).toBe(400);
    expect((await postSkill(request, a.access_token, a.user.id, { title: 123 })).status()).toBe(
        400,
    );

    // exact 200-char boundary is accepted
    const ok = await createSkillOk(request, a.access_token, a.user.id, {
        title: 'a'.repeat(200),
        slug: `t2-${uniq()}`,
    });
    expect(ok.title).toBe('a'.repeat(200));
});

test('CreateSkill description: MinLength 1 / MaxLength 1000 / string — empty, >1000, non-string 400; ==1000 → 201', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    expect(
        (await postSkill(request, a.access_token, a.user.id, { description: undefined })).status(),
    ).toBe(400);
    expect(
        (await postSkill(request, a.access_token, a.user.id, { description: '' })).status(),
    ).toBe(400);
    expect(
        (
            await postSkill(request, a.access_token, a.user.id, { description: 'd'.repeat(1001) })
        ).status(),
    ).toBe(400);
    expect(
        (await postSkill(request, a.access_token, a.user.id, { description: 42 })).status(),
    ).toBe(400);

    const ok = await createSkillOk(request, a.access_token, a.user.id, {
        description: 'd'.repeat(1000),
        slug: `de-${uniq()}`,
    });
    expect(ok.description).toBe('d'.repeat(1000));
});

test('CreateSkill instructionsMd: MaxLength 65536 with NO min — empty body ALLOWED (201), 64KB boundary exact, non-string 400', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    // missing / wrong type → 400
    expect(
        (
            await postSkill(request, a.access_token, a.user.id, { instructionsMd: undefined })
        ).status(),
    ).toBe(400);
    expect(
        (await postSkill(request, a.access_token, a.user.id, { instructionsMd: 999 })).status(),
    ).toBe(400);

    // empty string is a VALID body (no MinLength on this field)
    const empty = await createSkillOk(request, a.access_token, a.user.id, {
        instructionsMd: '',
        slug: `ie-${uniq()}`,
    });
    expect(empty.instructionsMd).toBe('');
    expect(empty.contentHash).toBe(sha256(''));

    // exactly 65536 chars → 201; 65537 → 400 (DTO MaxLength)
    const atCap = await postSkill(request, a.access_token, a.user.id, {
        instructionsMd: 'a'.repeat(65536),
        slug: `ic-${uniq()}`,
    });
    expect(atCap.status()).toBe(201);
    expect(
        (
            await postSkill(request, a.access_token, a.user.id, {
                instructionsMd: 'a'.repeat(65537),
                slug: `io-${uniq()}`,
            })
        ).status(),
    ).toBe(400);
});

test('CreateSkill frontmatter: IsObject — string/array/number 400; omitted → server default {name:slug,description}; object merges name/description', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    for (const bad of ['notobj', [], [1, 2], 5, true]) {
        expect(
            (await postSkill(request, a.access_token, a.user.id, { frontmatter: bad })).status(),
            `frontmatter=${JSON.stringify(bad)} must be rejected`,
        ).toBe(400);
    }

    // omitted → server derives { name: slug, description }
    const derived = await createSkillOk(request, a.access_token, a.user.id, {
        slug: `fmd-${uniq()}`,
        description: 'derived-desc',
        frontmatter: undefined,
    });
    const dfm = derived.frontmatter as Record<string, unknown>;
    expect(dfm.name).toBe(derived.slug);
    expect(dfm.description).toBe('derived-desc');

    // object WITHOUT name/description → name from slug, description from body,
    // extra keys preserved verbatim
    const slug = `fmm-${uniq()}`;
    const merged = await createSkillOk(request, a.access_token, a.user.id, {
        slug,
        description: 'body-desc',
        frontmatter: { custom: 'val', tags: ['x'] },
    });
    const mfm = merged.frontmatter as Record<string, unknown>;
    expect(mfm.name).toBe(slug);
    expect(mfm.description).toBe('body-desc');
    expect(mfm.custom).toBe('val');
    expect(mfm.tags).toEqual(['x']);
});

test('CreateSkill slug: Matches /^[a-z0-9-]{1,80}$/ — upper/underscore/space/empty/>80 → 400; ==80 and leading/trailing hyphen → 201', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    for (const bad of [
        'Bad_Slug',
        'has space',
        'UPPER',
        'under_score',
        '',
        'a'.repeat(81),
        'e/f',
    ]) {
        expect(
            (await postSkill(request, a.access_token, a.user.id, { slug: bad })).status(),
            `slug=${JSON.stringify(bad)} must be rejected`,
        ).toBe(400);
    }

    // exactly 80 chars is accepted and stored verbatim
    const at80 = 'a'.repeat(80);
    const ok80 = await createSkillOk(request, a.access_token, a.user.id, { slug: at80 });
    expect(ok80.slug).toBe(at80);

    // leading/trailing hyphens satisfy the pattern
    const hy = `-lead-${uniq()}-`;
    const okHy = await createSkillOk(request, a.access_token, a.user.id, { slug: hy });
    expect(okHy.slug).toBe(hy);
});

test('CreateSkill version: MaxLength 40 with NO min — >40 / non-string 400; empty string stored verbatim; free-form label accepted', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);

    expect(
        (await postSkill(request, a.access_token, a.user.id, { version: 'v'.repeat(41) })).status(),
    ).toBe(400);
    expect((await postSkill(request, a.access_token, a.user.id, { version: 3 })).status()).toBe(
        400,
    );

    // exactly 40 chars → 201
    const at40 = 'v'.repeat(40);
    const ok40 = await createSkillOk(request, a.access_token, a.user.id, {
        version: at40,
        slug: `v4-${uniq()}`,
    });
    expect(ok40.version).toBe(at40);

    // empty string is NOT coerced back to the '1.0.0' default (only undefined is)
    const emptyVer = await createSkillOk(request, a.access_token, a.user.id, {
        version: '',
        slug: `ve-${uniq()}`,
    });
    expect(emptyVer.version).toBe('');

    // arbitrary free-form label (non-semver) is honoured
    const free = await createSkillOk(request, a.access_token, a.user.id, {
        version: 'beta-2026.1',
        slug: `vf-${uniq()}`,
    });
    expect(free.version).toBe('beta-2026.1');

    // and the default when omitted is '1.0.0'
    const def = await createSkillOk(request, a.access_token, a.user.id, {
        version: undefined,
        slug: `vd-${uniq()}`,
    });
    expect(def.version).toBe('1.0.0');
});

test('CreateSkill rejects unknown fields (forbidNonWhitelisted) with the canonical property message', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const res = await postSkill(request, a.access_token, a.user.id, { bogusField: 1 });
    expect(res.status()).toBe(400);
    expect(JSON.stringify((await res.json()).message)).toContain(
        'property bogusField should not exist',
    );
});

// ─────────────────────────────────────────────────────────────────────────
// contentHash — exact sha256 invariants
// ─────────────────────────────────────────────────────────────────────────

test('contentHash equals sha256(instructionsMd) EXACTLY, and is identical across two skills with the same body', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const body = `# guide ${uniq()}\n\nWhen you see a cron expression, default to UTC.`;

    const s1 = await createSkillOk(request, a.access_token, a.user.id, {
        instructionsMd: body,
        slug: `h1-${uniq()}`,
    });
    expect(s1.contentHash).toBe(sha256(body));

    // A second skill (different scope-slug) with the identical body hashes identically.
    const s2 = await createSkillOk(request, a.access_token, a.user.id, {
        instructionsMd: body,
        slug: `h2-${uniq()}`,
    });
    expect(s2.contentHash).toBe(sha256(body));
    expect(s2.contentHash).toBe(s1.contentHash);
    expect(s2.id).not.toBe(s1.id);
});

test('PATCH recomputes contentHash from the new body (incl. empty ""), leaves it untouched on metadata-only edits', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const created = await createSkillOk(request, a.access_token, a.user.id, {
        instructionsMd: 'first body',
        slug: `hp-${uniq()}`,
    });
    const id = created.id as string;
    expect(created.contentHash).toBe(sha256('first body'));

    // body change → hash drifts to the exact new sha256
    const changed = 'second body — changed';
    const r1 = await request.patch(`${SKILLS}/${id}`, {
        headers: authedHeaders(a.access_token),
        data: { instructionsMd: changed },
    });
    expect(r1.status()).toBe(200);
    expect((await r1.json()).contentHash).toBe(sha256(changed));

    // metadata-only PATCH (title/version) does NOT touch the hash
    const r2 = await request.patch(`${SKILLS}/${id}`, {
        headers: authedHeaders(a.access_token),
        data: { title: 'Renamed', version: '9.9.9' },
    });
    const b2 = await r2.json();
    expect(r2.status()).toBe(200);
    expect(b2.contentHash).toBe(sha256(changed));
    expect(b2.title).toBe('Renamed');
    expect(b2.version).toBe('9.9.9');

    // PATCH body to empty string → hash of empty string
    const r3 = await request.patch(`${SKILLS}/${id}`, {
        headers: authedHeaders(a.access_token),
        data: { instructionsMd: '' },
    });
    expect(r3.status()).toBe(200);
    expect((await r3.json()).contentHash).toBe(sha256(''));
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH — per-field validation + whitelist
// ─────────────────────────────────────────────────────────────────────────

test('UpdateSkill validation: empty/oversize/wrong-type fields → 400; empty {} body → 200 no-op; unknown field → 400', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const created = await createSkillOk(request, a.access_token, a.user.id, {
        slug: `up-${uniq()}`,
    });
    const id = created.id as string;
    const patch = (data: Record<string, unknown>) =>
        request.patch(`${SKILLS}/${id}`, { headers: authedHeaders(a.access_token), data });

    expect((await patch({ title: '' })).status()).toBe(400);
    expect((await patch({ title: 'a'.repeat(201) })).status()).toBe(400);
    expect((await patch({ description: '' })).status()).toBe(400);
    expect((await patch({ description: 'd'.repeat(1001) })).status()).toBe(400);
    expect((await patch({ version: 'v'.repeat(41) })).status()).toBe(400);
    expect((await patch({ frontmatter: [] })).status()).toBe(400);
    expect((await patch({ instructionsMd: 123 })).status()).toBe(400);
    expect((await patch({ bogus: 1 })).status()).toBe(400);

    // empty body is a legal no-op that returns the unchanged row
    const noop = await patch({});
    expect(noop.status()).toBe(200);
    expect((await noop.json()).id).toBe(id);
});

test('UpdateSkill treats ownerType / ownerId / slug as immutable (not whitelisted) → 400', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const created = await createSkillOk(request, a.access_token, a.user.id, {
        slug: `im-${uniq()}`,
    });
    const id = created.id as string;
    const patch = (data: Record<string, unknown>) =>
        request.patch(`${SKILLS}/${id}`, { headers: authedHeaders(a.access_token), data });

    for (const field of ['ownerType', 'ownerId', 'slug'] as const) {
        const res = await patch({ [field]: field === 'ownerType' ? 'agent' : randomUUID() });
        expect(res.status(), `${field} must be rejected as non-whitelisted`).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain(
            `property ${field} should not exist`,
        );
    }
});

// ─────────────────────────────────────────────────────────────────────────
// BINDINGS — per-field validation matrix
// ─────────────────────────────────────────────────────────────────────────

test('CreateBinding targetType: enum required + validated; all 5 values pass DTO (tenant → 201, non-tenant w/o targetId → 400 rule)', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `bt-${uniq()}` });
    const id = skill.id as string;

    // missing / invalid / wrong-type → 400
    expect((await postBinding(request, a.access_token, id, { priority: 5 })).status()).toBe(400);
    expect((await postBinding(request, a.access_token, id, { targetType: 'nope' })).status()).toBe(
        400,
    );
    expect((await postBinding(request, a.access_token, id, { targetType: 9 })).status()).toBe(400);

    // tenant passes the DTO AND the service rule (no targetId needed) → 201
    const tenant = await postBinding(request, a.access_token, id, { targetType: 'tenant' });
    expect(tenant.status()).toBe(201);
    const trow = await tenant.json();
    expect(trow.targetType).toBe('tenant');
    expect(trow.targetId).toBeNull();

    // agent/work/mission/idea all pass the enum, then trip the "targetId required" rule → 400
    for (const targetType of ['agent', 'work', 'mission', 'idea'] as const) {
        const res = await postBinding(request, a.access_token, id, { targetType });
        expect(res.status(), `${targetType} needs targetId`).toBe(400);
        expect((await res.json()).message).toBe(
            `targetId is required when targetType=${targetType}.`,
        );
    }
});

test('CreateBinding targetId: non-uuid → 400; explicit null + tenant → 201; tenant + supplied unknown id → 404 (server resolves it); foreign non-owned target → 404', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `bi-${uniq()}` });
    const id = skill.id as string;

    // non-uuid targetId → 400
    expect(
        (
            await postBinding(request, a.access_token, id, { targetType: 'agent', targetId: 'xx' })
        ).status(),
    ).toBe(400);

    // explicit null + tenant → 201, stored null
    const nullTenant = await postBinding(request, a.access_token, id, {
        targetType: 'tenant',
        targetId: null,
    });
    expect(nullTenant.status()).toBe(201);
    expect((await nullTenant.json()).targetId).toBeNull();

    // tenant WITH a supplied targetId → the server RESOLVES the supplied id
    // (it does not silently null it): an unknown uuid fails the scope gate the
    // same way a foreign agent target does → 404 "Skill target not found."
    const forced = await postBinding(request, a.access_token, id, {
        targetType: 'tenant',
        targetId: randomUUID(),
    });
    expect(forced.status()).toBe(404);
    expect((await forced.json()).message).toBe('Skill target not found.');

    // well-formed but NON-owned agent target uuid → scope gate 404
    const foreign = await postBinding(request, a.access_token, id, {
        targetType: 'agent',
        targetId: randomUUID(),
    });
    expect(foreign.status()).toBe(404);
    expect((await foreign.json()).message).toBe('Skill target not found.');
});

test('CreateBinding priority: IsInt Min 1 Max 1000 — 0 / 1001 / float → 400; 1 and 1000 boundaries → 201', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `bp-${uniq()}` });
    const id = skill.id as string;

    for (const bad of [0, 1001, 1.5, -5]) {
        expect(
            (
                await postBinding(request, a.access_token, id, {
                    targetType: 'tenant',
                    priority: bad,
                })
            ).status(),
            `priority=${bad} must be rejected`,
        ).toBe(400);
    }

    const p1 = await postBinding(request, a.access_token, id, {
        targetType: 'tenant',
        priority: 1,
    });
    expect(p1.status()).toBe(201);
    expect((await p1.json()).priority).toBe(1);

    const p1000 = await postBinding(request, a.access_token, id, {
        targetType: 'tenant',
        priority: 1000,
    });
    expect(p1000.status()).toBe(201);
    expect((await p1000.json()).priority).toBe(1000);
});

test('CreateBinding inject flags: non-boolean → 400; defaults are priority 100 / injectIntoAgent true / injectIntoGenerator false; unknown field → 400', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `bf-${uniq()}` });
    const id = skill.id as string;

    expect(
        (
            await postBinding(request, a.access_token, id, {
                targetType: 'tenant',
                injectIntoAgent: 'yes',
            })
        ).status(),
    ).toBe(400);
    expect(
        (
            await postBinding(request, a.access_token, id, {
                targetType: 'tenant',
                injectIntoGenerator: 1,
            })
        ).status(),
    ).toBe(400);
    expect(
        (
            await postBinding(request, a.access_token, id, { targetType: 'tenant', bogus: 1 })
        ).status(),
    ).toBe(400);

    // defaults on a bare tenant binding
    const def = await postBinding(request, a.access_token, id, { targetType: 'tenant' });
    expect(def.status()).toBe(201);
    const row = await def.json();
    expect(row.priority).toBe(100);
    expect(row.injectIntoAgent).toBe(true);
    expect(row.injectIntoGenerator).toBe(false);
    expect(row.userId).toBe(a.user.id);
});

test('CreateBinding to an OWNED agent target echoes the agent id; binding a FOREIGN agent id → 404 scope', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const b = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `ba-${uniq()}` });
    const skillId = skill.id as string;

    const agentA = await createAgentViaAPI(request, a.access_token, { name: `AgentA ${uniq()}` });
    const agentB = await createAgentViaAPI(request, b.access_token, { name: `AgentB ${uniq()}` });

    // owned agent target → 201 and the row carries the exact agent id
    const ok = await postBinding(request, a.access_token, skillId, {
        targetType: 'agent',
        targetId: agentA.id,
    });
    expect(ok.status()).toBe(201);
    const okRow = await ok.json();
    expect(okRow.targetType).toBe('agent');
    expect(okRow.targetId).toBe(agentA.id);

    // another user's agent id is not an owned scope → 404 (no existence leak)
    const foreign = await postBinding(request, a.access_token, skillId, {
        targetType: 'agent',
        targetId: agentB.id,
    });
    expect(foreign.status()).toBe(404);
    expect((await foreign.json()).message).toBe('Skill target not found.');
});

// ─────────────────────────────────────────────────────────────────────────
// AUTHZ — anon / malformed / unknown / cross-user surface
// ─────────────────────────────────────────────────────────────────────────

test('the whole write surface demands a bearer — anonymous POST/PATCH/DELETE are uniform 401s', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `an-${uniq()}` });
    const id = skill.id as string;
    const someUuid = randomUUID();

    const calls = [
        request.post(SKILLS, {
            data: {
                ownerType: 'tenant',
                ownerId: a.user.id,
                title: 't',
                description: 'd',
                instructionsMd: 'b',
            },
        }),
        request.patch(`${SKILLS}/${id}`, { data: { title: 'x' } }),
        request.delete(`${SKILLS}/${id}`),
        request.get(`${SKILLS}/${id}/bindings`),
        request.post(`${SKILLS}/${id}/bindings`, { data: { targetType: 'tenant' } }),
        request.delete(`${API_BASE}/api/skill-bindings/${someUuid}`),
    ];
    for (const res of await Promise.all(calls)) {
        expect(res.status()).toBe(401);
    }
});

test('ParseUUIDPipe: malformed ids → 400 "Validation failed (uuid is expected)" across every :id route', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const h = authedHeaders(a.access_token);

    const calls = [
        request.get(`${SKILLS}/not-a-uuid`, { headers: h }),
        request.patch(`${SKILLS}/not-a-uuid`, { headers: h, data: { title: 'x' } }),
        request.delete(`${SKILLS}/not-a-uuid`, { headers: h }),
        request.get(`${SKILLS}/not-a-uuid/bindings`, { headers: h }),
        request.post(`${SKILLS}/not-a-uuid/bindings`, {
            headers: h,
            data: { targetType: 'tenant' },
        }),
        request.delete(`${API_BASE}/api/skill-bindings/not-a-uuid`, { headers: h }),
    ];
    for (const res of await Promise.all(calls)) {
        expect(res.status()).toBe(400);
        expect(JSON.stringify((await res.json()).message)).toContain('uuid is expected');
    }
});

test('unknown-but-valid uuid → 404 on GET/PATCH/DELETE skill and GET/POST its bindings', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const h = authedHeaders(a.access_token);
    const ghost = randomUUID();

    expect((await request.get(`${SKILLS}/${ghost}`, { headers: h })).status()).toBe(404);
    expect(
        (await request.patch(`${SKILLS}/${ghost}`, { headers: h, data: { title: 'x' } })).status(),
    ).toBe(404);
    expect((await request.delete(`${SKILLS}/${ghost}`, { headers: h })).status()).toBe(404);
    expect((await request.get(`${SKILLS}/${ghost}/bindings`, { headers: h })).status()).toBe(404);
    expect(
        (
            await request.post(`${SKILLS}/${ghost}/bindings`, {
                headers: h,
                data: { targetType: 'tenant' },
            })
        ).status(),
    ).toBe(404);
    expect(
        (await request.delete(`${API_BASE}/api/skill-bindings/${ghost}`, { headers: h })).status(),
    ).toBe(404);
});

test('cross-user isolation: user B gets 404 (never 403) on user A skill read/patch/delete + bindings list/create + binding delete', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const b = await registerUserViaAPI(request);

    const skill = await createSkillOk(request, a.access_token, a.user.id, { slug: `xu-${uniq()}` });
    const skillId = skill.id as string;

    // A owns a binding that B will try to delete
    const bindRes = await postBinding(request, a.access_token, skillId, { targetType: 'tenant' });
    expect(bindRes.status()).toBe(201);
    const bindingId = (await bindRes.json()).id as string;

    const hb = authedHeaders(b.access_token);
    const results = await Promise.all([
        request.get(`${SKILLS}/${skillId}`, { headers: hb }),
        request.patch(`${SKILLS}/${skillId}`, { headers: hb, data: { title: 'hax' } }),
        request.delete(`${SKILLS}/${skillId}`, { headers: hb }),
        request.get(`${SKILLS}/${skillId}/bindings`, { headers: hb }),
        request.post(`${SKILLS}/${skillId}/bindings`, {
            headers: hb,
            data: { targetType: 'tenant' },
        }),
        request.delete(`${API_BASE}/api/skill-bindings/${bindingId}`, { headers: hb }),
    ]);
    for (const res of results) {
        expect([403, 404]).toContain(res.status());
        expect(res.status()).toBe(404); // posture is 404, no existence leak
    }

    // ...and A's skill + binding are untouched by B's failed attempts
    const stillThere = await request.get(`${SKILLS}/${skillId}`, {
        headers: authedHeaders(a.access_token),
    });
    expect(stillThere.status()).toBe(200);
    const list = await request.get(`${SKILLS}/${skillId}/bindings`, {
        headers: authedHeaders(a.access_token),
    });
    const rows = (await list.json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(bindingId);
});

test('cross-tenant scope gate: creating a skill owned by ANOTHER user id → 404, no row leaks into their list', async ({
    request,
}) => {
    const a = await registerUserViaAPI(request);
    const b = await registerUserViaAPI(request);

    // A tries to plant a tenant skill under B's user id
    const res = await postSkill(request, a.access_token, b.user.id, {
        ownerType: 'tenant',
        slug: `ct-${uniq()}`,
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).message).toBe('Skill target not found.');

    // B's own skill list is unaffected (no cross-planted row)
    const bList = await request.get(SKILLS, { headers: authedHeaders(b.access_token) });
    expect(bList.status()).toBe(200);
    const body = await bList.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as Array<{ slug: string }>).some((s) => s.slug.startsWith('ct-'))).toBe(
        false,
    );
});
