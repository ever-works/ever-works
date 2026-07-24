import { test, expect, type APIRequestContext } from '@playwright/test';
import { registerUserViaAPI, authedHeaders, API_BASE } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import { createTriggerViaAPI, TRIGGERS_BASE } from './helpers/triggers';

/**
 * Inbound Triggers — DTO VALIDATION + LIFECYCLE-STATE + AUTHZ matrix.
 *
 * Distinct angle vs the sibling specs:
 *   - flow-inbound-triggers-deep.spec.ts      → happy-path CRUD + the public HMAC fire path.
 *   - flow-inbound-triggers-security-deep.spec.ts → fire signature/timestamp/content-type/ordering.
 * This file is the EXHAUSTIVE per-field validation matrix for the *management*
 * surface (POST + PATCH), the lifecycle-state ops (pause/resume/rotate), and
 * the full authz/param edge set. It deliberately does NOT fire triggers.
 *
 * Probed LIVE against http://127.0.0.1:3100 (sqlite in-memory, flags ON):
 *
 * CreateInboundTriggerDto  (POST /api/inbound-triggers → 201 { trigger, secret }):
 *   name              required · @IsString @Length(1,120)
 *                       missing/null/number → 400 ["name must be a string", …]
 *                       ""                  → 400 ["name must be longer than or equal to 1 characters"]
 *                       121 chars           → 400 ["name must be shorter than or equal to 120 characters"]
 *                       "   " (whitespace)  → 400 SERVICE msg "Trigger name must be 1-120 characters."
 *                       1 / 120 chars       → 201
 *   description       optional · @IsString @MaxLength(2000); null & "" accepted (201); 2001 → 400
 *   kind              optional · @IsIn(['webhook','api']); null → 201 (defaults 'webhook'); other → 400
 *   targetAgentId     optional · @IsUUID + must belong to caller
 *                       malformed uuid      → 400 ["targetAgentId must be a UUID"]
 *                       valid foreign/unknown uuid → 400 SERVICE "Agent <id> is not reachable…"
 *                       null / owned agent  → 201
 *   taskTitleTemplate optional · @IsString @MaxLength(200); null(create N/A) "" accepted; 201-char → 400
 *   unknown field     → 400 ["property <x> should not exist"]  (forbidNonWhitelisted)
 *
 * UpdateInboundTriggerDto  (PATCH /api/inbound-triggers/:id → 200 view):
 *   NO `kind` field → {"kind":…} → 400 ["property kind should not exist"].
 *   name/description/targetAgentId/taskTitleTemplate mirror create's constraints, BUT
 *   description/targetAgentId/taskTitleTemplate use @ValidateIf(v !== null) so an explicit
 *   `null` is accepted and CLEARS the field (200). Empty body {} → 200 no-op.
 *
 * Param + authz (every management route):
 *   malformed uuid → 400 (ParseUUIDPipe "Validation failed (uuid is expected)")
 *   unknown valid uuid / foreign owner → 404 "Inbound trigger not found"  (never 403 — anti-enumeration)
 *   no auth → 401
 *
 * Lifecycle state ops carry NO wrong-state validation — they are IDEMPOTENT:
 *   pause is 200 whether active or already paused; resume is 200 either way;
 *   rotate-secret is 200 even while paused and stamps `rotatedAt` + returns a fresh secret once.
 */

const suffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';
const FOREIGN_UUID = '11111111-1111-4111-8111-111111111111';

/** Register a fresh user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    const u = await registerUserViaAPI(request);
    return u.access_token;
}

/** POST a create body verbatim and return { status, body }. */
async function rawCreate(request: APIRequestContext, token: string, data: unknown) {
    const res = await request.post(TRIGGERS_BASE, { headers: authedHeaders(token), data });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/** PATCH a create body verbatim and return { status, body }. */
async function rawPatch(request: APIRequestContext, token: string, id: string, data: unknown) {
    const res = await request.patch(`${TRIGGERS_BASE}/${id}`, {
        headers: authedHeaders(token),
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/** class-validator errors arrive as a string[] in `message`; assert one entry matches. */
function expectValidatorMessage(body: Record<string, unknown>, needle: string) {
    expect(
        Array.isArray(body.message),
        `expected array message, got ${JSON.stringify(body.message)}`,
    ).toBe(true);
    expect((body.message as string[]).some((m) => m.includes(needle))).toBe(true);
}

// ───────────────────────────────────────────────────────────────────────────
// CREATE — `name` field matrix
// ───────────────────────────────────────────────────────────────────────────
test.describe('POST /api/inbound-triggers — name validation', () => {
    test('missing name → 400 with both string+length validator messages', async ({ request }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, {});
        expect(status).toBe(400);
        expectValidatorMessage(body, 'name must be a string');
        expectValidatorMessage(body, 'name must be longer than or equal to 1 characters');
    });

    test('empty-string and null name → 400 (length floor)', async ({ request }) => {
        const token = await freshToken(request);
        const empty = await rawCreate(request, token, { name: '' });
        expect(empty.status).toBe(400);
        expectValidatorMessage(empty.body, 'longer than or equal to 1');

        const nul = await rawCreate(request, token, { name: null });
        expect(nul.status).toBe(400);
        expectValidatorMessage(nul.body, 'name must be a string');
    });

    test('whitespace-only name passes the pipe but the SERVICE rejects it (distinct message)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, { name: '   ' });
        expect(status).toBe(400);
        // NOT the class-validator array — this is the service-layer trim() guard.
        expect(body.message).toBe('Trigger name must be 1-120 characters.');
    });

    test('name length boundaries: 1 and 120 → 201, 121 → 400', async ({ request }) => {
        const token = await freshToken(request);
        const one = await createTriggerViaAPI(request, token, { name: 'a' });
        expect(one.trigger.name).toBe('a');

        const max = await createTriggerViaAPI(request, token, { name: 'y'.repeat(120) });
        expect(max.trigger.name.length).toBe(120);

        const over = await rawCreate(request, token, { name: 'x'.repeat(121) });
        expect(over.status).toBe(400);
        expectValidatorMessage(over.body, 'shorter than or equal to 120 characters');
    });

    test('non-string name (number) → 400', async ({ request }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, { name: 123 });
        expect(status).toBe(400);
        expectValidatorMessage(body, 'name must be a string');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CREATE — description / kind / taskTitleTemplate matrices
// ───────────────────────────────────────────────────────────────────────────
test.describe('POST /api/inbound-triggers — optional scalar fields', () => {
    test('description boundary: 2000 → 201, 2001 → 400, number → 400', async ({ request }) => {
        const token = await freshToken(request);
        const ok = await createTriggerViaAPI(request, token, {
            name: `d-${suffix()}`,
            description: 'd'.repeat(2000),
        });
        expect(ok.trigger.description?.length).toBe(2000);

        const over = await rawCreate(request, token, { name: 'D', description: 'd'.repeat(2001) });
        expect(over.status).toBe(400);
        expectValidatorMessage(
            over.body,
            'description must be shorter than or equal to 2000 characters',
        );

        const num = await rawCreate(request, token, { name: 'D', description: 42 });
        expect(num.status).toBe(400);
        expectValidatorMessage(num.body, 'description must be a string');
    });

    test('description accepts null and "" (IsOptional short-circuits) → 201, stored as given', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const asNull = await rawCreate(request, token, { name: 'DN', description: null });
        expect(asNull.status).toBe(201);
        const asEmpty = await createTriggerViaAPI(request, token, { name: 'DE', description: '' });
        // null is normalised to null; "" is preserved through the view.
        expect([null, '']).toContain((asEmpty.trigger.description ?? null) as string | null);
    });

    test('kind: "api" and "webhook" accepted+reflected, null defaults to webhook, other → 400', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const api = await createTriggerViaAPI(request, token, { name: 'KA', kind: 'api' });
        expect(api.trigger.kind).toBe('api');
        const wh = await createTriggerViaAPI(request, token, { name: 'KW', kind: 'webhook' });
        expect(wh.trigger.kind).toBe('webhook');

        const nul = await rawCreate(request, token, { name: 'KN', kind: null });
        expect(nul.status).toBe(201);
        expect((nul.body.trigger as { kind: string }).kind).toBe('webhook');

        const bad = await rawCreate(request, token, { name: 'KB', kind: 'cron' });
        expect(bad.status).toBe(400);
        expectValidatorMessage(bad.body, 'kind must be one of the following values: webhook, api');

        const numKind = await rawCreate(request, token, { name: 'KX', kind: 5 });
        expect(numKind.status).toBe(400);
        expectValidatorMessage(numKind.body, 'kind must be one of the following values');
    });

    test('taskTitleTemplate boundary: 200 → 201, 201 → 400, number → 400, "" → 201', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const ok = await createTriggerViaAPI(request, token, {
            name: `T-${suffix()}`,
            taskTitleTemplate: 't'.repeat(200),
        });
        expect(ok.trigger.id).toBeTruthy();

        const over = await rawCreate(request, token, {
            name: 'T',
            taskTitleTemplate: 't'.repeat(201),
        });
        expect(over.status).toBe(400);
        expectValidatorMessage(
            over.body,
            'taskTitleTemplate must be shorter than or equal to 200 characters',
        );

        const num = await rawCreate(request, token, { name: 'T', taskTitleTemplate: 9 });
        expect(num.status).toBe(400);
        expectValidatorMessage(num.body, 'taskTitleTemplate must be a string');

        const empty = await rawCreate(request, token, { name: 'TE', taskTitleTemplate: '' });
        expect(empty.status).toBe(201);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CREATE — targetAgentId (uuid shape + ownership) matrix
// ───────────────────────────────────────────────────────────────────────────
test.describe('POST /api/inbound-triggers — targetAgentId ownership', () => {
    test('malformed uuid rejected by @IsUUID BEFORE the ownership check → 400 (uuid message)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, {
            name: 'A',
            targetAgentId: 'not-a-uuid',
        });
        expect(status).toBe(400);
        expectValidatorMessage(body, 'targetAgentId must be a UUID');
    });

    test('well-formed but unreachable/unknown agent uuid → 400 with the SERVICE reachability message', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, {
            name: 'A',
            targetAgentId: FOREIGN_UUID,
        });
        expect(status).toBe(400);
        // Distinct from the @IsUUID array — this is the service-layer "not reachable" guard.
        expect(String(body.message)).toContain('is not reachable for this user');
    });

    test("another user's real agent is NOT reachable → 400; the owner's own agent → 201 and is reflected", async ({
        request,
    }) => {
        const ownerToken = await freshToken(request);
        const strangerToken = await freshToken(request);
        const agent = await createAgentViaAPI(request, ownerToken, {
            name: `Ag-${suffix()}`,
            scope: 'tenant',
        });

        // stranger cannot borrow the owner's agent
        const foreign = await rawCreate(request, strangerToken, {
            name: 'Foreign',
            targetAgentId: agent.id,
        });
        expect(foreign.status).toBe(400);
        expect(String(foreign.body.message)).toContain('is not reachable');

        // owner can, and the assignment surfaces in the view
        const owned = await createTriggerViaAPI(request, ownerToken, {
            name: 'Owned',
            targetAgentId: agent.id,
        });
        expect(owned.trigger.targetAgentId).toBe(agent.id);
    });

    test('null targetAgentId is accepted (no ownership probe) → 201', async ({ request }) => {
        const token = await freshToken(request);
        const res = await rawCreate(request, token, { name: 'AN', targetAgentId: null });
        expect(res.status).toBe(201);
        expect((res.body.trigger as { targetAgentId: string | null }).targetAgentId).toBeNull();
    });
});

// ───────────────────────────────────────────────────────────────────────────
// CREATE — whitelist + auth edges
// ───────────────────────────────────────────────────────────────────────────
test.describe('POST /api/inbound-triggers — body whitelist + auth', () => {
    test('an unknown extra property → 400 (forbidNonWhitelisted)', async ({ request }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, { name: 'E', bogus: 'x' });
        expect(status).toBe(400);
        expectValidatorMessage(body, 'property bogus should not exist');
    });

    test('server-owned fields (status) cannot be injected via create → 400', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { status, body } = await rawCreate(request, token, { name: 'E', status: 'paused' });
        expect(status).toBe(400);
        expectValidatorMessage(body, 'property status should not exist');
    });

    test('no auth on create and list → 401', async ({ request }) => {
        const create = await request.post(TRIGGERS_BASE, { data: { name: 'x' } });
        expect(create.status()).toBe(401);
        const list = await request.get(TRIGGERS_BASE);
        expect(list.status()).toBe(401);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH — update DTO field matrix (incl. null-clearing + forbidden `kind`)
// ───────────────────────────────────────────────────────────────────────────
test.describe('PATCH /api/inbound-triggers/:id — field validation', () => {
    test('`kind` is not part of the update DTO → 400 (property should not exist)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `K-${suffix()}` });
        const { status, body } = await rawPatch(request, token, trigger.id, { kind: 'api' });
        expect(status).toBe(400);
        expectValidatorMessage(body, 'property kind should not exist');
    });

    test('name on update mirrors create: "" → 400, whitespace → 400 (service), 121 → 400, valid → 200', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `N-${suffix()}` });

        const empty = await rawPatch(request, token, trigger.id, { name: '' });
        expect(empty.status).toBe(400);
        expectValidatorMessage(empty.body, 'longer than or equal to 1');

        const ws = await rawPatch(request, token, trigger.id, { name: '   ' });
        expect(ws.status).toBe(400);
        expect(ws.body.message).toBe('Trigger name must be 1-120 characters.');

        const over = await rawPatch(request, token, trigger.id, { name: 'x'.repeat(121) });
        expect(over.status).toBe(400);
        expectValidatorMessage(over.body, 'shorter than or equal to 120');

        const ok = await rawPatch(request, token, trigger.id, { name: 'Renamed' });
        expect(ok.status).toBe(200);
        expect((ok.body as { name: string }).name).toBe('Renamed');
    });

    test('description: explicit null CLEARS (200 via ValidateIf), 2001 → 400', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, {
            name: `D-${suffix()}`,
            description: 'seed',
        });
        const cleared = await rawPatch(request, token, trigger.id, { description: null });
        expect(cleared.status).toBe(200);
        expect((cleared.body as { description: string | null }).description).toBeNull();

        const over = await rawPatch(request, token, trigger.id, { description: 'd'.repeat(2001) });
        expect(over.status).toBe(400);
        expectValidatorMessage(over.body, 'description must be shorter than or equal to 2000');
    });

    test('targetAgentId: null CLEARS (200), malformed → 400, foreign uuid → 400 (not reachable)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentViaAPI(request, token, {
            name: `Ag-${suffix()}`,
            scope: 'tenant',
        });
        const { trigger } = await createTriggerViaAPI(request, token, {
            name: `A-${suffix()}`,
            targetAgentId: agent.id,
        });

        const cleared = await rawPatch(request, token, trigger.id, { targetAgentId: null });
        expect(cleared.status).toBe(200);
        expect((cleared.body as { targetAgentId: string | null }).targetAgentId).toBeNull();

        const malformed = await rawPatch(request, token, trigger.id, { targetAgentId: 'nope' });
        expect(malformed.status).toBe(400);
        expectValidatorMessage(malformed.body, 'targetAgentId must be a UUID');

        const foreign = await rawPatch(request, token, trigger.id, { targetAgentId: FOREIGN_UUID });
        expect(foreign.status).toBe(400);
        expect(String(foreign.body.message)).toContain('is not reachable');
    });

    test('taskTitleTemplate: null accepted (200), 201-char → 400', async ({ request }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `T-${suffix()}` });
        const nul = await rawPatch(request, token, trigger.id, { taskTitleTemplate: null });
        expect(nul.status).toBe(200);
        const over = await rawPatch(request, token, trigger.id, {
            taskTitleTemplate: 't'.repeat(201),
        });
        expect(over.status).toBe(400);
        expectValidatorMessage(over.body, 'taskTitleTemplate must be shorter than or equal to 200');
    });

    test('empty body {} is a valid no-op (200), an unknown property → 400', async ({ request }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `E-${suffix()}` });
        const noop = await rawPatch(request, token, trigger.id, {});
        expect(noop.status).toBe(200);
        expect((noop.body as { id: string }).id).toBe(trigger.id);

        const extra = await rawPatch(request, token, trigger.id, { bogus: 1 });
        expect(extra.status).toBe(400);
        expectValidatorMessage(extra.body, 'property bogus should not exist');
    });

    test('multi-field update applies name + description + agent together and reflects all', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentViaAPI(request, token, {
            name: `Ag-${suffix()}`,
            scope: 'tenant',
        });
        const { trigger } = await createTriggerViaAPI(request, token, { name: `M-${suffix()}` });
        const res = await rawPatch(request, token, trigger.id, {
            name: 'AllThree',
            description: 'hello',
            targetAgentId: agent.id,
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            name: 'AllThree',
            description: 'hello',
            targetAgentId: agent.id,
        });
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Param shape + authz matrix — every management route
// ───────────────────────────────────────────────────────────────────────────
type RouteCall = (
    request: APIRequestContext,
    token: string | null,
    id: string,
) => Promise<{ status: () => number }>;

const MANAGEMENT_ROUTES: { name: string; call: RouteCall }[] = [
    {
        name: 'GET :id',
        call: (r, t, id) => r.get(`${TRIGGERS_BASE}/${id}`, { headers: t ? authedHeaders(t) : {} }),
    },
    {
        name: 'PATCH :id',
        call: (r, t, id) =>
            r.patch(`${TRIGGERS_BASE}/${id}`, {
                headers: t ? authedHeaders(t) : {},
                data: { name: 'z' },
            }),
    },
    {
        name: 'DELETE :id',
        call: (r, t, id) =>
            r.delete(`${TRIGGERS_BASE}/${id}`, { headers: t ? authedHeaders(t) : {} }),
    },
    {
        name: 'POST :id/pause',
        call: (r, t, id) =>
            r.post(`${TRIGGERS_BASE}/${id}/pause`, { headers: t ? authedHeaders(t) : {} }),
    },
    {
        name: 'POST :id/resume',
        call: (r, t, id) =>
            r.post(`${TRIGGERS_BASE}/${id}/resume`, { headers: t ? authedHeaders(t) : {} }),
    },
    {
        name: 'POST :id/rotate-secret',
        call: (r, t, id) =>
            r.post(`${TRIGGERS_BASE}/${id}/rotate-secret`, { headers: t ? authedHeaders(t) : {} }),
    },
];

test.describe('Inbound Triggers — param + authz matrix', () => {
    test('a malformed uuid path param → 400 on every management route (ParseUUIDPipe)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const route of MANAGEMENT_ROUTES) {
            const res = await route.call(request, token, 'not-a-uuid');
            expect(res.status(), `${route.name} malformed-uuid`).toBe(400);
        }
        // and the exact pipe message on a GET
        const get = await request.get(`${TRIGGERS_BASE}/not-a-uuid`, {
            headers: authedHeaders(token),
        });
        expect((await get.json()).message).toBe('Validation failed (uuid is expected)');
    });

    test('a well-formed but unknown uuid → 404 on every management route (never 403)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        for (const route of MANAGEMENT_ROUTES) {
            const res = await route.call(request, token, UNKNOWN_UUID);
            expect(res.status(), `${route.name} unknown-uuid`).toBe(404);
        }
        const get = await request.get(`${TRIGGERS_BASE}/${UNKNOWN_UUID}`, {
            headers: authedHeaders(token),
        });
        expect((await get.json()).message).toBe('Inbound trigger not found');
    });

    test('no auth → 401 on every management route', async ({ request }) => {
        for (const route of MANAGEMENT_ROUTES) {
            const res = await route.call(request, null, UNKNOWN_UUID);
            expect(res.status(), `${route.name} no-auth`).toBe(401);
        }
    });

    test("cross-user: another user's trigger is 404 (not 403) on every management route", async ({
        request,
    }) => {
        const ownerToken = await freshToken(request);
        const strangerToken = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, ownerToken, {
            name: `Iso-${suffix()}`,
        });

        for (const route of MANAGEMENT_ROUTES) {
            const res = await route.call(request, strangerToken, trigger.id);
            expect(res.status(), `${route.name} cross-user`).toBe(404);
        }

        // the owner's trigger is untouched by the stranger's DELETE attempt
        const stillThere = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(ownerToken),
        });
        expect(stillThere.status()).toBe(200);
    });

    test("list is caller-scoped: a stranger never sees the owner's trigger", async ({
        request,
    }) => {
        const ownerToken = await freshToken(request);
        const strangerToken = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, ownerToken, {
            name: `Scoped-${suffix()}`,
        });

        const ownerList = await request.get(TRIGGERS_BASE, { headers: authedHeaders(ownerToken) });
        const ownerIds = ((await ownerList.json()).triggers as { id: string }[]).map((t) => t.id);
        expect(ownerIds).toContain(trigger.id);

        const strangerList = await request.get(TRIGGERS_BASE, {
            headers: authedHeaders(strangerToken),
        });
        const strangerIds = ((await strangerList.json()).triggers as { id: string }[]).map(
            (t) => t.id,
        );
        expect(strangerIds).not.toContain(trigger.id);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Lifecycle-state ops — idempotency + rotate (no wrong-state validation)
// ───────────────────────────────────────────────────────────────────────────
test.describe('Inbound Triggers — lifecycle-state ops are idempotent', () => {
    test('pause on an active trigger → 200 paused; pause AGAIN (already paused) → 200 still paused', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `P-${suffix()}` });

        const first = await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(first.status()).toBe(200);
        expect((await first.json()).status).toBe('paused');

        // no wrong-state guard — pausing a paused trigger is a clean no-op, not a 409
        const again = await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, {
            headers: authedHeaders(token),
        });
        expect(again.status()).toBe(200);
        expect((await again.json()).status).toBe('paused');
    });

    test('resume on an active trigger → 200 active; resume again → 200 (idempotent, no 409)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `R-${suffix()}` });

        const first = await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, {
            headers: authedHeaders(token),
        });
        expect(first.status()).toBe(200);
        expect((await first.json()).status).toBe('active');

        const again = await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, {
            headers: authedHeaders(token),
        });
        expect(again.status()).toBe(200);
        expect((await again.json()).status).toBe('active');
    });

    test('pause → resume round-trips the status field back to active', async ({ request }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `RT-${suffix()}` });

        await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, {
            headers: authedHeaders(token),
        });
        const paused = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
        });
        expect((await paused.json()).status).toBe('paused');

        await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, {
            headers: authedHeaders(token),
        });
        const active = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
        });
        expect((await active.json()).status).toBe('active');
    });

    test('rotate-secret returns a fresh secret ONCE, stamps rotatedAt, and works even while paused', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const created = await createTriggerViaAPI(request, token, { name: `Rot-${suffix()}` });
        expect(created.trigger.rotatedAt).toBeNull();

        const first = await request.post(`${TRIGGERS_BASE}/${created.trigger.id}/rotate-secret`, {
            headers: authedHeaders(token),
        });
        expect(first.status()).toBe(200);
        const firstBody = await first.json();
        expect(typeof firstBody.secret).toBe('string');
        expect(firstBody.secret.length).toBeGreaterThan(20);
        expect(firstBody.secret).not.toBe(created.secret);
        expect(firstBody.trigger.rotatedAt).not.toBeNull();

        // rotation carries no state gate — pause, then rotate again succeeds (200) with another new secret
        await request.post(`${TRIGGERS_BASE}/${created.trigger.id}/pause`, {
            headers: authedHeaders(token),
        });
        const second = await request.post(`${TRIGGERS_BASE}/${created.trigger.id}/rotate-secret`, {
            headers: authedHeaders(token),
        });
        expect(second.status()).toBe(200);
        expect((await second.json()).secret).not.toBe(firstBody.secret);
    });

    test('the trigger view never leaks secret material on create, get, or rotate', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const created = await createTriggerViaAPI(request, token, { name: `Leak-${suffix()}` });
        // create returns { trigger, secret } — the VIEW itself must carry no secret keys
        expect(created.trigger).not.toHaveProperty('secret');
        expect(created.trigger).not.toHaveProperty('secretEncrypted');
        expect(created.trigger).not.toHaveProperty('previousSecretEncrypted');

        const got = await request.get(`${TRIGGERS_BASE}/${created.trigger.id}`, {
            headers: authedHeaders(token),
        });
        const view = await got.json();
        expect(view).not.toHaveProperty('secret');
        expect(view).not.toHaveProperty('secretEncrypted');
    });

    test('DELETE → 204, then GET the same id → 404', async ({ request }) => {
        const token = await freshToken(request);
        const { trigger } = await createTriggerViaAPI(request, token, { name: `Del-${suffix()}` });
        const del = await request.delete(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
        });
        expect(del.status()).toBe(204);
        const get = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(token),
        });
        expect(get.status()).toBe(404);
    });
});
