import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Agents — CreateAgentDto / UpdateAgentDto exhaustive VALIDATION + AUTHZ
 * matrix (POST /api/agents, PATCH /api/agents/:id).
 *
 * DISTINCT ANGLE vs the existing agent specs. The scoping matrices
 * (flow-agent-scoping-matrix[-deep]) own the scope-cascade / parent
 * cardinality / ownership rules; the permissions matrix owns the 8-flag
 * merge/coercion; the guardrails-policy-deep + scorecards-deep specs own
 * the PUT /:id/guardrails and PATCH scorecard field validation. This file
 * is the class-validator-level FIELD matrix for every OTHER Create/Update
 * DTO field — one assertion cluster per field — plus the full authz set.
 * It deliberately does NOT re-cover scope-requires-parent, permission
 * merge, guardrails, or scorecard business rules.
 *
 * Every status code + error shape below was probed against the LIVE API
 * (sqlite in-memory, all flags on — the same driver CI runs) before an
 * assertion was written. The global pipe is
 * `ValidationPipe { whitelist, transform, forbidNonWhitelisted }` so an
 * unknown property is a 400, and class-validator messages arrive as a
 * `message: string[]` array — EXCEPT two service-level guards that throw a
 * single-string `message`:
 *   • a whitespace-only name → "Agent name must contain at least one
 *     alphanumeric character."
 *   • a malformed :id → ParseUUIDPipe "Validation failed (uuid is expected)".
 *
 * CREATE contract (probed):
 *   POST /api/agents { scope:'tenant', name } → 201 with defaults
 *     maxSkillContextTokens:4000, pauseAfterFailures:3, idleBehavior:'propose',
 *     avatarMode:'initials', status:'draft', permissions all-false,
 *     targets:null, guardrails:null, scorecard:null.
 *   Field rules (each → 400 unless noted):
 *     scope        IsEnum(tenant|mission|idea|work); missing/unknown → 400.
 *     name         string, 1..120, IsNotEmpty; number → "must be a string";
 *                  ""→ empty+min msgs; 121→ max; 120→ 201; "   "→ single-string
 *                  service message; surrounding-space-but-alnum → 201 (slug trimmed).
 *     title        <=200; ""→ 201 (no min).
 *     capabilities <=5000.
 *     aiProviderId <=100.   modelId <=100.
 *     maxSkillContextTokens int 0..20000; float/string/neg/over → 400; 0 & 20000 → 201.
 *     heartbeatCadence <=64; "manual" → 201.
 *     idleBehavior IsEnum(propose|noop|observe).
 *     pauseAfterFailures int 1..20; 0/21 → 400; 1 & 20 → 201.
 *     permissions  nested: non-boolean → "permissions.<f> must be a boolean value";
 *                  unknown nested key → "permissions.property <k> should not exist".
 *     targets      array of { type:mission|idea|work|wildcard, id?:uuid };
 *                  non-array / bad type / missing type / bad id → 400; wildcard → 201.
 *     avatarMode   IsEnum(initials|icon|image); avatarIcon <=64;
 *                  avatarImageUploadId IsUUID.
 *     committerEmail IsEmail; committerName <=120.
 *     missionId/ideaId/workId IsUUID (malformed → "<field> must be a UUID").
 *     unknown top-level property → "property <k> should not exist".
 *
 * UPDATE contract (probed):
 *   PATCH /api/agents/:id — {} → 200 no-op; every field re-validated with the
 *   SAME bounds; name "" → ONLY the min-length msg (UpdateAgentDto.name has no
 *   @IsNotEmpty); nullable fields (title/committerEmail/reportsToAgentId/…)
 *   accept null; scope/missionId/ideaId/workId are NOT update fields →
 *   "property <k> should not exist"; reportsToAgentId IsUUID (null clears).
 *
 * AUTHZ (probed):
 *   No bearer → 401 on every verb. Cross-user read/write → 404 (existence is
 *   never leaked via 403). BUT the ValidationPipe runs BEFORE the service
 *   ownership check, so a cross-user PATCH with a MALFORMED body → 400 (pipe),
 *   not 404. Malformed :id → 400 (ParseUUIDPipe); unknown-but-valid uuid → 404.
 *
 * Isolation: every test registers a FRESH user (never the shared seeded
 * user) so the in-memory DB stays clean for sibling specs; assertions are
 * id-keyed (toContain / not.toContain), never global counts. POST /api/agents
 * is throttled 30/min/user (keyed by userId) — each test stays well under.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const SOME_UUID = '11111111-2222-4333-8444-555555555555';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** class-validator returns message: string[]; two service guards return a string. */
function messageText(body: { message?: unknown }): string {
    const m = body?.message;
    return Array.isArray(m) ? m.join(' | ') : String(m);
}

/** Raw create POST so non-2xx statuses + bodies are assertable. */
function rawCreate(request: APIRequestContext, token: string, data: Record<string, unknown>) {
    return request.post(`${API_BASE}/api/agents`, { headers: authedHeaders(token), data });
}

/** Raw PATCH. */
function rawPatch(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
) {
    return request.patch(`${API_BASE}/api/agents/${id}`, { headers: authedHeaders(token), data });
}

/** Create a valid tenant agent and return its parsed DTO (asserts 201). */
async function createOk(
    request: APIRequestContext,
    token: string,
    data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const res = await rawCreate(request, token, { scope: 'tenant', ...data });
    expect(res.status(), `create body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

// ─────────────────────────────────────────────────────────────────────────
test.describe('Agent create DTO — field validation matrix', () => {
    test('happy-path minimal create seeds the full documented default envelope', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const dto = await createOk(request, token, { name: `Defaults ${stamp()}` });

        expect(dto.id).toMatch(UUID_RE);
        expect(dto.scope).toBe('tenant');
        expect(dto.status).toBe('draft');
        // Every server-defaulted field is pinned exactly.
        expect(dto.maxSkillContextTokens).toBe(4000);
        expect(dto.pauseAfterFailures).toBe(3);
        expect(dto.idleBehavior).toBe('propose');
        expect(dto.avatarMode).toBe('initials');
        expect(dto.title).toBeNull();
        expect(dto.capabilities).toBeNull();
        expect(dto.aiProviderId).toBeNull();
        expect(dto.modelId).toBeNull();
        expect(dto.targets).toBeNull();
        expect(dto.guardrails).toBeNull();
        expect(dto.scorecard).toBeNull();
        expect(dto.missionId).toBeNull();
        expect(dto.ideaId).toBeNull();
        expect(dto.workId).toBeNull();
        expect(dto.permissions).toEqual({
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        });
    });

    test('scope: missing or unknown → 400 IsEnum; the four enum members are the only accepted values', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const enumMsg = 'scope must be one of the following values: tenant, mission, idea, work';

        const missing = await rawCreate(request, token, { name: `No Scope ${stamp()}` });
        expect(missing.status()).toBe(400);
        expect(messageText(await missing.json())).toContain(enumMsg);

        const bad = await rawCreate(request, token, {
            scope: 'galaxy',
            name: `Bad Scope ${stamp()}`,
        });
        expect(bad.status()).toBe(400);
        expect(messageText(await bad.json())).toContain(enumMsg);

        const numeric = await rawCreate(request, token, { scope: 7, name: `Num Scope ${stamp()}` });
        expect(numeric.status()).toBe(400);

        // tenant is a legitimate value → 201 (parent-cardinality lives in the
        // scoping spec; here we only prove the enum accepts a valid member).
        const ok = await createOk(request, token, { name: `Scope Ok ${stamp()}` });
        expect(ok.scope).toBe('tenant');
    });

    test('name: required, 1..120 chars, must be a string, and must carry an alphanumeric', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const missing = await rawCreate(request, token, { scope: 'tenant' });
        expect(missing.status()).toBe(400);
        expect(messageText(await missing.json())).toContain('name should not be empty');

        const empty = await rawCreate(request, token, { scope: 'tenant', name: '' });
        expect(empty.status()).toBe(400);
        const emptyMsg = messageText(await empty.json());
        expect(emptyMsg).toContain('name should not be empty');
        expect(emptyMsg).toContain('name must be longer than or equal to 1 characters');

        const tooLong = await rawCreate(request, token, { scope: 'tenant', name: 'n'.repeat(121) });
        expect(tooLong.status()).toBe(400);
        expect(messageText(await tooLong.json())).toContain(
            'name must be shorter than or equal to 120 characters',
        );

        const numberName = await rawCreate(request, token, { scope: 'tenant', name: 123 });
        expect(numberName.status()).toBe(400);
        expect(messageText(await numberName.json())).toContain('name must be a string');

        // Whitespace-only is rejected by a SERVICE guard with a single-string
        // message (not the class-validator array) — distinct from the min-length path.
        const blank = await rawCreate(request, token, { scope: 'tenant', name: '   ' });
        expect(blank.status()).toBe(400);
        const blankBody = await blank.json();
        expect(Array.isArray(blankBody.message)).toBe(false);
        expect(messageText(blankBody)).toMatch(/at least one alphanumeric character/i);

        // Exactly 120 is the inclusive upper bound → 201.
        const at120 = await createOk(request, token, { name: 'x'.repeat(120) });
        expect((at120.name as string).length).toBe(120);

        // Surrounding spaces around alphanumerics are accepted; the slug is trimmed.
        const padded = await createOk(request, token, { name: `  Padded ${stamp()}  ` });
        expect((padded.slug as string).startsWith('padded')).toBe(true);
    });

    test('title: <=200 chars; an empty string is accepted (no min-length)', async ({ request }) => {
        const token = await freshToken(request);

        const tooLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Title Long ${stamp()}`,
            title: 't'.repeat(201),
        });
        expect(tooLong.status()).toBe(400);
        expect(messageText(await tooLong.json())).toContain(
            'title must be shorter than or equal to 200 characters',
        );

        const at200 = await createOk(request, token, {
            name: `Title 200 ${stamp()}`,
            title: 't'.repeat(200),
        });
        expect((at200.title as string).length).toBe(200);

        const emptyTitle = await createOk(request, token, {
            name: `Title Empty ${stamp()}`,
            title: '',
        });
        expect(emptyTitle.title).toBe('');
    });

    test('capabilities: <=5000 chars (5000 accepted, 5001 rejected)', async ({ request }) => {
        const token = await freshToken(request);

        const tooLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Cap Long ${stamp()}`,
            capabilities: 'c'.repeat(5001),
        });
        expect(tooLong.status()).toBe(400);
        expect(messageText(await tooLong.json())).toContain(
            'capabilities must be shorter than or equal to 5000 characters',
        );

        const at5000 = await createOk(request, token, {
            name: `Cap 5000 ${stamp()}`,
            capabilities: 'c'.repeat(5000),
        });
        expect((at5000.capabilities as string).length).toBe(5000);
    });

    test('aiProviderId and modelId: each <=100 chars', async ({ request }) => {
        const token = await freshToken(request);

        const provLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Prov Long ${stamp()}`,
            aiProviderId: 'p'.repeat(101),
        });
        expect(provLong.status()).toBe(400);
        expect(messageText(await provLong.json())).toContain(
            'aiProviderId must be shorter than or equal to 100 characters',
        );

        const modelLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Model Long ${stamp()}`,
            modelId: 'm'.repeat(101),
        });
        expect(modelLong.status()).toBe(400);
        expect(messageText(await modelLong.json())).toContain(
            'modelId must be shorter than or equal to 100 characters',
        );

        const ok = await createOk(request, token, {
            name: `Model Ok ${stamp()}`,
            aiProviderId: 'p'.repeat(100),
            modelId: 'openrouter/some-model',
        });
        expect(ok.aiProviderId).toBe('p'.repeat(100));
        expect(ok.modelId).toBe('openrouter/some-model');
    });

    test('maxSkillContextTokens: integer 0..20000 — rejects float/string/negative/over, accepts the bounds', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const neg = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tok Neg ${stamp()}`,
            maxSkillContextTokens: -1,
        });
        expect(neg.status()).toBe(400);
        expect(messageText(await neg.json())).toContain(
            'maxSkillContextTokens must not be less than 0',
        );

        const over = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tok Over ${stamp()}`,
            maxSkillContextTokens: 20001,
        });
        expect(over.status()).toBe(400);
        expect(messageText(await over.json())).toContain(
            'maxSkillContextTokens must not be greater than 20000',
        );

        const float = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tok Float ${stamp()}`,
            maxSkillContextTokens: 1.5,
        });
        expect(float.status()).toBe(400);
        expect(messageText(await float.json())).toContain(
            'maxSkillContextTokens must be an integer number',
        );

        // A numeric STRING is NOT coerced (no @Type(() => Number) on this field).
        const str = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tok Str ${stamp()}`,
            maxSkillContextTokens: '5000',
        });
        expect(str.status()).toBe(400);
        expect(messageText(await str.json())).toContain(
            'maxSkillContextTokens must be an integer number',
        );

        const at0 = await createOk(request, token, {
            name: `Tok 0 ${stamp()}`,
            maxSkillContextTokens: 0,
        });
        expect(at0.maxSkillContextTokens).toBe(0);
        const atMax = await createOk(request, token, {
            name: `Tok Max ${stamp()}`,
            maxSkillContextTokens: 20000,
        });
        expect(atMax.maxSkillContextTokens).toBe(20000);
    });

    test('heartbeatCadence: DTO <=64 chars (array msg) AND a service cron/manual guard (single-string msg); "manual" + a real cron pass', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // Layer 1 — DTO MaxLength(64): the pipe rejects an over-long value with
        // the class-validator ARRAY message before the service ever sees it.
        const tooLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `HB Long ${stamp()}`,
            heartbeatCadence: 'h'.repeat(65),
        });
        expect(tooLong.status()).toBe(400);
        expect(messageText(await tooLong.json())).toContain(
            'heartbeatCadence must be shorter than or equal to 64 characters',
        );

        // Layer 2 — a length-valid but non-cron / non-"manual" value is rejected
        // by the SERVICE with a single-string message (not the pipe array).
        const notCron = await rawCreate(request, token, {
            scope: 'tenant',
            name: `HB NotCron ${stamp()}`,
            heartbeatCadence: 'everyday',
        });
        expect(notCron.status()).toBe(400);
        const notCronBody = await notCron.json();
        expect(Array.isArray(notCronBody.message)).toBe(false);
        expect(messageText(notCronBody)).toMatch(/Invalid heartbeatCadence/i);

        // "manual" and a genuine cron expression are both accepted.
        const manual = await createOk(request, token, {
            name: `HB Manual ${stamp()}`,
            heartbeatCadence: 'manual',
        });
        expect(manual.heartbeatCadence).toBe('manual');

        const cron = await createOk(request, token, {
            name: `HB Cron ${stamp()}`,
            heartbeatCadence: '0 * * * *',
        });
        expect(cron.heartbeatCadence).toBe('0 * * * *');
    });

    test('idleBehavior: IsEnum(propose|noop|observe) — each valid member accepted, others 400', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const bad = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Idle Bad ${stamp()}`,
            idleBehavior: 'sleep',
        });
        expect(bad.status()).toBe(400);
        expect(messageText(await bad.json())).toContain(
            'idleBehavior must be one of the following values: propose, noop, observe',
        );

        for (const behavior of ['propose', 'noop', 'observe'] as const) {
            const ok = await createOk(request, token, {
                name: `Idle ${behavior} ${stamp()}`,
                idleBehavior: behavior,
            });
            expect(ok.idleBehavior).toBe(behavior);
        }
    });

    test('pauseAfterFailures: integer 1..20 — 0 and 21 rejected, 1 and 20 accepted', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const zero = await rawCreate(request, token, {
            scope: 'tenant',
            name: `PAF 0 ${stamp()}`,
            pauseAfterFailures: 0,
        });
        expect(zero.status()).toBe(400);
        expect(messageText(await zero.json())).toContain(
            'pauseAfterFailures must not be less than 1',
        );

        const over = await rawCreate(request, token, {
            scope: 'tenant',
            name: `PAF 21 ${stamp()}`,
            pauseAfterFailures: 21,
        });
        expect(over.status()).toBe(400);
        expect(messageText(await over.json())).toContain(
            'pauseAfterFailures must not be greater than 20',
        );

        const one = await createOk(request, token, {
            name: `PAF 1 ${stamp()}`,
            pauseAfterFailures: 1,
        });
        expect(one.pauseAfterFailures).toBe(1);
        const twenty = await createOk(request, token, {
            name: `PAF 20 ${stamp()}`,
            pauseAfterFailures: 20,
        });
        expect(twenty.pauseAfterFailures).toBe(20);
    });

    test('permissions: nested DTO — non-boolean flag and unknown nested key each 400; a valid partial seeds', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const nonBool = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Perm NonBool ${stamp()}`,
            permissions: { canEditSkills: 'yes' },
        });
        expect(nonBool.status()).toBe(400);
        expect(messageText(await nonBool.json())).toMatch(
            /permissions\.canEditSkills must be a boolean value/i,
        );

        // forbidNonWhitelisted applies to the NESTED object too.
        const unknownKey = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Perm Unknown ${stamp()}`,
            permissions: { canFly: true },
        });
        expect(unknownKey.status()).toBe(400);
        expect(messageText(await unknownKey.json())).toMatch(
            /permissions\.property canFly should not exist/i,
        );

        const seeded = await createOk(request, token, {
            name: `Perm Seed ${stamp()}`,
            permissions: { canSpend: true, canCallExternalTools: true },
        });
        const perms = seeded.permissions as Record<string, boolean>;
        expect(perms.canSpend).toBe(true);
        expect(perms.canCallExternalTools).toBe(true);
        expect(perms.canEditSkills).toBe(false);
    });

    test('targets: array of typed entries — non-array, bad type, missing type, and bad id all 400; a wildcard entry round-trips', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const notArray = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tgt NotArr ${stamp()}`,
            targets: 'x',
        });
        expect(notArray.status()).toBe(400);
        expect(messageText(await notArray.json())).toContain('targets must be an array');

        const badType = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tgt BadType ${stamp()}`,
            targets: [{ type: 'nope' }],
        });
        expect(badType.status()).toBe(400);
        expect(messageText(await badType.json())).toMatch(/targets\.0\.type must be one of/i);

        const missingType = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tgt NoType ${stamp()}`,
            targets: [{ id: SOME_UUID }],
        });
        expect(missingType.status()).toBe(400);
        expect(messageText(await missingType.json())).toMatch(/targets\.0\.type must be one of/i);

        const badId = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Tgt BadId ${stamp()}`,
            targets: [{ type: 'work', id: 'not-a-uuid' }],
        });
        expect(badId.status()).toBe(400);
        expect(messageText(await badId.json())).toContain('targets.0.id must be a UUID');

        const wildcard = await createOk(request, token, {
            name: `Tgt Wildcard ${stamp()}`,
            targets: [{ type: 'wildcard' }],
        });
        expect(wildcard.targets).toEqual([{ type: 'wildcard' }]);

        // A well-formed uuid id passes DTO validation (existence is not checked here).
        const withId = await createOk(request, token, {
            name: `Tgt WithId ${stamp()}`,
            targets: [{ type: 'work', id: SOME_UUID }],
        });
        expect(Array.isArray(withId.targets)).toBe(true);
    });

    test('avatar cluster: avatarMode enum, avatarIcon <=64, avatarImageUploadId IsUUID', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const badMode = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Av Bad ${stamp()}`,
            avatarMode: 'hologram',
        });
        expect(badMode.status()).toBe(400);
        expect(messageText(await badMode.json())).toContain(
            'avatarMode must be one of the following values: initials, icon, image',
        );

        const iconLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Av Icon Long ${stamp()}`,
            avatarIcon: 'i'.repeat(65),
        });
        expect(iconLong.status()).toBe(400);
        expect(messageText(await iconLong.json())).toContain(
            'avatarIcon must be shorter than or equal to 64 characters',
        );

        const badUpload = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Av Upload ${stamp()}`,
            avatarImageUploadId: 'not-a-uuid',
        });
        expect(badUpload.status()).toBe(400);
        expect(messageText(await badUpload.json())).toContain('avatarImageUploadId must be a UUID');

        const ok = await createOk(request, token, {
            name: `Av Ok ${stamp()}`,
            avatarMode: 'icon',
            avatarIcon: 'rocket',
        });
        expect(ok.avatarMode).toBe('icon');
        expect(ok.avatarIcon).toBe('rocket');
    });

    test('committer identity: committerEmail IsEmail, committerName <=120', async ({ request }) => {
        const token = await freshToken(request);

        const badEmail = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Email Bad ${stamp()}`,
            committerEmail: 'not-an-email',
        });
        expect(badEmail.status()).toBe(400);
        expect(messageText(await badEmail.json())).toContain('committerEmail must be an email');

        const nameLong = await rawCreate(request, token, {
            scope: 'tenant',
            name: `CName Long ${stamp()}`,
            committerName: 'c'.repeat(121),
        });
        expect(nameLong.status()).toBe(400);
        expect(messageText(await nameLong.json())).toContain(
            'committerName must be shorter than or equal to 120 characters',
        );

        const ok = await createOk(request, token, {
            name: `Committer Ok ${stamp()}`,
            committerEmail: 'dev@example.com',
            committerName: 'Ada Lovelace',
        });
        expect(ok.committerEmail).toBe('dev@example.com');
        expect(ok.committerName).toBe('Ada Lovelace');
    });

    test('parent ids (missionId/ideaId/workId) are IsUUID — a malformed value is a 400 per field', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const mission = await rawCreate(request, token, {
            scope: 'mission',
            name: `Mis Uuid ${stamp()}`,
            missionId: 'not-a-uuid',
        });
        expect(mission.status()).toBe(400);
        expect(messageText(await mission.json())).toContain('missionId must be a UUID');

        const idea = await rawCreate(request, token, {
            scope: 'idea',
            name: `Idea Uuid ${stamp()}`,
            ideaId: 'xyz',
        });
        expect(idea.status()).toBe(400);
        expect(messageText(await idea.json())).toContain('ideaId must be a UUID');

        const work = await rawCreate(request, token, {
            scope: 'work',
            name: `Work Uuid ${stamp()}`,
            workId: '123',
        });
        expect(work.status()).toBe(400);
        expect(messageText(await work.json())).toContain('workId must be a UUID');
    });

    test('forbidNonWhitelisted: an unknown top-level property is a 400; an empty body reports the required fields', async ({
        request,
    }) => {
        const token = await freshToken(request);

        const extra = await rawCreate(request, token, {
            scope: 'tenant',
            name: `Extra ${stamp()}`,
            bogusField: 1,
        });
        expect(extra.status()).toBe(400);
        expect(messageText(await extra.json())).toContain('property bogusField should not exist');

        const empty = await rawCreate(request, token, {});
        expect(empty.status()).toBe(400);
        const emptyMsg = messageText(await empty.json());
        expect(emptyMsg).toContain('scope must be one of the following values');
        expect(emptyMsg).toContain('name should not be empty');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('Agent update (PATCH) DTO — field validation matrix', () => {
    test('name/title on update: name 1..120 (min-only message, no @IsNotEmpty); title <=200 or null', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Patch NT ${stamp()}` });
        const id = agent.id as string;

        // UpdateAgentDto.name has NO @IsNotEmpty → "" yields ONLY the min-length msg.
        const emptyName = await rawPatch(request, token, id, { name: '' });
        expect(emptyName.status()).toBe(400);
        const emptyMsg = messageText(await emptyName.json());
        expect(emptyMsg).toContain('name must be longer than or equal to 1 characters');
        expect(emptyMsg).not.toContain('should not be empty');

        const longName = await rawPatch(request, token, id, { name: 'n'.repeat(121) });
        expect(longName.status()).toBe(400);
        expect(messageText(await longName.json())).toContain(
            'name must be shorter than or equal to 120 characters',
        );

        const longTitle = await rawPatch(request, token, id, { title: 't'.repeat(201) });
        expect(longTitle.status()).toBe(400);
        expect(messageText(await longTitle.json())).toContain(
            'title must be shorter than or equal to 200 characters',
        );

        // title is nullable on update → null clears it (200).
        const clearTitle = await rawPatch(request, token, id, { title: null });
        expect(clearTitle.status()).toBe(200);
        expect((await clearTitle.json()).title).toBeNull();

        // A legitimate rename round-trips.
        const renamed = await rawPatch(request, token, id, {
            name: `Renamed ${stamp()}`,
            title: 'Lead',
        });
        expect(renamed.status()).toBe(200);
        const renamedDto = await renamed.json();
        expect(renamedDto.title).toBe('Lead');
    });

    test('numeric + enum + email fields re-validate on update with the same bounds', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Patch NEE ${stamp()}` });
        const id = agent.id as string;

        const overTokens = await rawPatch(request, token, id, { maxSkillContextTokens: 20001 });
        expect(overTokens.status()).toBe(400);
        expect(messageText(await overTokens.json())).toContain(
            'maxSkillContextTokens must not be greater than 20000',
        );

        const negTokens = await rawPatch(request, token, id, { maxSkillContextTokens: -5 });
        expect(negTokens.status()).toBe(400);

        const badPaf = await rawPatch(request, token, id, { pauseAfterFailures: 0 });
        expect(badPaf.status()).toBe(400);
        expect(messageText(await badPaf.json())).toContain(
            'pauseAfterFailures must not be less than 1',
        );

        const badIdle = await rawPatch(request, token, id, { idleBehavior: 'sleep' });
        expect(badIdle.status()).toBe(400);
        expect(messageText(await badIdle.json())).toContain(
            'idleBehavior must be one of the following values: propose, noop, observe',
        );

        const badAvatar = await rawPatch(request, token, id, { avatarMode: 'hologram' });
        expect(badAvatar.status()).toBe(400);

        const badEmail = await rawPatch(request, token, id, { committerEmail: 'nope' });
        expect(badEmail.status()).toBe(400);
        expect(messageText(await badEmail.json())).toContain('committerEmail must be an email');

        // A valid batch of the same fields is accepted and persisted.
        const ok = await rawPatch(request, token, id, {
            maxSkillContextTokens: 8000,
            pauseAfterFailures: 5,
            idleBehavior: 'observe',
            avatarMode: 'initials',
            committerEmail: 'ok@example.com',
        });
        expect(ok.status()).toBe(200);
        const okDto = await ok.json();
        expect(okDto.maxSkillContextTokens).toBe(8000);
        expect(okDto.pauseAfterFailures).toBe(5);
        expect(okDto.idleBehavior).toBe('observe');
        expect(okDto.committerEmail).toBe('ok@example.com');
    });

    test('reportsToAgentId (update-only field): IsUUID guarded; null clears it', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Reports ${stamp()}` });
        const id = agent.id as string;

        const badUuid = await rawPatch(request, token, id, { reportsToAgentId: 'not-a-uuid' });
        expect(badUuid.status()).toBe(400);
        expect(messageText(await badUuid.json())).toContain('reportsToAgentId must be a UUID');

        // reportsToAgentId is nullable on update → null clears the manager link (200).
        const clear = await rawPatch(request, token, id, { reportsToAgentId: null });
        expect(clear.status()).toBe(200);
        expect((await clear.json()).reportsToAgentId).toBeNull();
    });

    test('create-only fields are NOT accepted on PATCH — scope/missionId/ideaId/workId + any unknown key → 400', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Patch Forbidden ${stamp()}` });
        const id = agent.id as string;

        for (const [field, value] of [
            ['scope', 'work'],
            ['missionId', UNKNOWN_UUID],
            ['ideaId', UNKNOWN_UUID],
            ['workId', UNKNOWN_UUID],
            ['bogusField', 1],
        ] as const) {
            const res = await rawPatch(request, token, id, { [field]: value });
            expect(res.status(), `PATCH {${field}} should be 400`).toBe(400);
            expect(messageText(await res.json())).toContain(`property ${field} should not exist`);
        }
    });

    test('PATCH accepts an empty body (no-op) and a partial single-field update (merge, not replace)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, {
            name: `Patch Partial ${stamp()}`,
            title: 'Original',
        });
        const id = agent.id as string;

        // Empty body is a valid no-op → 200, nothing changed.
        const noop = await rawPatch(request, token, id, {});
        expect(noop.status()).toBe(200);
        const noopDto = await noop.json();
        expect(noopDto.id).toBe(id);
        expect(noopDto.title).toBe('Original');

        // A single-field permission partial merges (other flags untouched).
        const partial = await rawPatch(request, token, id, { permissions: { canSpend: true } });
        expect(partial.status()).toBe(200);
        const partialPerms = (await partial.json()).permissions as Record<string, boolean>;
        expect(partialPerms.canSpend).toBe(true);
        expect(partialPerms.canCommitToRepo).toBe(false);
        // The untouched title survived the permission-only PATCH.
        const after = await request.get(`${API_BASE}/api/agents/${id}`, {
            headers: authedHeaders(token),
        });
        expect((await after.json()).title).toBe('Original');
    });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('Agent create/update — authz + isolation matrix', () => {
    test('PATCH id-handling: malformed uuid → 400 (ParseUUIDPipe, single-string); unknown uuid → 404; own id → 200', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Id Handling ${stamp()}` });
        const id = agent.id as string;

        const malformed = await rawPatch(request, token, 'not-a-uuid', { title: 'x' });
        expect(malformed.status()).toBe(400);
        const malformedBody = await malformed.json();
        // ParseUUIDPipe emits a single-string message, not the class-validator array.
        expect(Array.isArray(malformedBody.message)).toBe(false);
        expect(String(malformedBody.message)).toMatch(/uuid is expected/i);

        const unknown = await rawPatch(request, token, UNKNOWN_UUID, { title: 'x' });
        expect(unknown.status()).toBe(404);
        expect(messageText(await unknown.json())).toBe(`Agent ${UNKNOWN_UUID} not found.`);

        const own = await rawPatch(request, token, id, { title: 'Mine' });
        expect(own.status()).toBe(200);
    });

    test('cross-user isolation: a foreign agent is 404 across GET/PATCH/DELETE/pause and never appears in the attacker list', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const attacker = await freshToken(request);
        const atk = authedHeaders(attacker);

        const agent = await createOk(request, owner, { name: `Isolated ${stamp()}` });
        const id = agent.id as string;
        const url = `${API_BASE}/api/agents/${id}`;

        const foreignGet = await request.get(url, { headers: atk });
        expect(foreignGet.status()).toBe(404);
        expect(messageText(await foreignGet.json())).toBe(`Agent ${id} not found.`);

        const foreignPatch = await request.patch(url, { headers: atk, data: { title: 'hijack' } });
        expect(foreignPatch.status()).toBe(404);

        const foreignPause = await request.post(`${url}/pause`, { headers: atk });
        expect(foreignPause.status()).toBe(404);

        const foreignDelete = await request.delete(url, { headers: atk });
        expect(foreignDelete.status()).toBe(404);

        // The attacker's own agent list never surfaces the owner's agent.
        const atkList = await request.get(`${API_BASE}/api/agents`, { headers: atk });
        expect(atkList.status()).toBe(200);
        const atkIds = ((await atkList.json()).data as Array<{ id: string }>).map((a) => a.id);
        expect(atkIds).not.toContain(id);

        // Sanity: the owner still reads + mutates it (the 404s are ownership-scoped).
        const ownerGet = await request.get(url, { headers: authedHeaders(owner) });
        expect(ownerGet.status()).toBe(200);
        expect((await ownerGet.json()).id).toBe(id);
    });

    test('the ValidationPipe runs BEFORE the ownership check — a cross-user PATCH with a bad body 400s (pipe), a valid body 404s (ownership)', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const attacker = await freshToken(request);
        const agent = await createOk(request, owner, { name: `Pipe First ${stamp()}` });
        const url = `${API_BASE}/api/agents/${agent.id}`;

        // Malformed body → 400 from the pipe, decided before the service can 404.
        const badBody = await request.patch(url, {
            headers: authedHeaders(attacker),
            data: { maxSkillContextTokens: 99999 },
        });
        expect(badBody.status()).toBe(400);
        expect(messageText(await badBody.json())).toContain(
            'maxSkillContextTokens must not be greater than 20000',
        );

        // A structurally VALID body reaches the service → 404 (no existence leak).
        const goodBody = await request.patch(url, {
            headers: authedHeaders(attacker),
            data: { title: 'hijack' },
        });
        expect(goodBody.status()).toBe(404);
    });

    test('unauthenticated requests are 401 across create/list/get/update/delete/pause', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createOk(request, token, { name: `Unauth ${stamp()}` });
        const url = `${API_BASE}/api/agents/${agent.id}`;
        const noAuth = { 'content-type': 'application/json' };

        const create = await request.post(`${API_BASE}/api/agents`, {
            headers: noAuth,
            data: { scope: 'tenant', name: `Anon ${stamp()}` },
        });
        expect(create.status()).toBe(401);

        const list = await request.get(`${API_BASE}/api/agents`, { headers: noAuth });
        expect(list.status()).toBe(401);

        const get = await request.get(url, { headers: noAuth });
        expect(get.status()).toBe(401);

        const patch = await request.patch(url, { headers: noAuth, data: { title: 'x' } });
        expect(patch.status()).toBe(401);

        const del = await request.delete(url, { headers: noAuth });
        expect(del.status()).toBe(401);

        const pause = await request.post(`${url}/pause`, { headers: noAuth });
        expect(pause.status()).toBe(401);

        // The agent is untouched — the owner still reads it.
        const stillThere = await request.get(url, { headers: authedHeaders(token) });
        expect(stillThere.status()).toBe(200);
    });
});
