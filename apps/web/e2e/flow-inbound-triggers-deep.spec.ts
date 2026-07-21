/**
 * Inbound Triggers — signed webhook/API triggers that spawn Tasks, DEEP (#1712).
 *
 * The whole feature shipped with no dedicated e2e coverage. This file drives
 * the real management surface + the PUBLIC HMAC fire endpoint end-to-end,
 * proving the security contract byte-for-byte against a live stack:
 *
 *   • create returns the trigger view + the raw secret ONCE; get-by-id never
 *     leaks secret material
 *   • list shape { triggers: [] }
 *   • fire with a correct HMAC-SHA256 signature → 200 { ok, taskId, taskSlug }
 *     and a real Task is spawned with the title from the trigger's template
 *   • fireCount increments + lastFiredAt stamps on a successful fire
 *   • fire negatives — bad signature / missing headers / stale timestamp (>5min)
 *     all → 401 (constant-shape); unknown id → 404; malformed id → 400
 *   • pause → fire 409 → resume → fire 200 (lifecycle)
 *   • rotate-secret → new secret verifies AND the previous secret still verifies
 *     inside the 24h grace window; returns the new secret once
 *   • update patches name / description / taskTitleTemplate
 *   • delete → 204, then fire → 404
 *   • oversized payload (>64 KB) with a valid signature → 400
 *   • cross-user isolation: every management route on another user's trigger → 404
 *   • unauth list → 401
 *
 * ── Verified live (http://127.0.0.1:3100, sqlite in-memory) before assertions.
 *    See helpers/triggers.ts for the probed contract + the HMAC signing helper.
 *
 * Fully API-orchestrated; fresh registerUserViaAPI() owners per test.
 */
import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import {
    TRIGGERS_BASE,
    createTriggerViaAPI,
    fireTrigger,
    nowEpochSeconds,
    signPayload,
    type InboundTriggerView,
} from './helpers/triggers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

test.describe('Inbound Triggers — management surface', () => {
    test('create returns the trigger view + a one-time secret; get-by-id leaks no secret', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Deploy hook ${stamp()}`,
            kind: 'webhook',
            taskTitleTemplate: 'Fired: {name}',
        });
        expect(trigger.id).toMatch(UUID_RE);
        expect(trigger.kind).toBe('webhook');
        expect(trigger.fireCount).toBe(0);
        expect(trigger.lastFiredAt).toBeNull();
        expect(typeof secret).toBe('string');
        expect(secret.length).toBeGreaterThanOrEqual(24);

        const got = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(got.status()).toBe(200);
        const view = await got.json();
        expect(view.id).toBe(trigger.id);
        // No secret material on the view.
        expect(view.secret).toBeUndefined();
        expect(JSON.stringify(view)).not.toContain(secret);
    });

    test("list returns { triggers: [] } and includes the caller's trigger; unauth → 401", async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `List me ${stamp()}`,
        });
        const list = await request.get(TRIGGERS_BASE, {
            headers: authedHeaders(user.access_token),
        });
        expect(list.status()).toBe(200);
        const body = await list.json();
        expect(Array.isArray(body.triggers)).toBe(true);
        expect(body.triggers.map((t: InboundTriggerView) => t.id)).toContain(trigger.id);

        expect((await request.get(TRIGGERS_BASE)).status()).toBe(401);
    });

    test('update patches name + description + taskTitleTemplate', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, user.access_token, {
            name: `Before ${stamp()}`,
        });
        const patched = await request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(user.access_token),
            data: { name: 'After', description: 'edited', taskTitleTemplate: 'New: {name}' },
        });
        expect(patched.status()).toBe(200);
        const body = await patched.json();
        expect(body.name).toBe('After');
        expect(body.description).toBe('edited');
        expect(body.taskTitleTemplate).toBe('New: {name}');
    });

    test('delete → 204; a subsequent fire on the deleted id → 404', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Ephemeral ${stamp()}`,
        });
        const del = await request.delete(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(del.status()).toBe(204);
        expect(
            (
                await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
                    headers: authedHeaders(user.access_token),
                })
            ).status(),
        ).toBe(404);
        const fire = await fireTrigger(request, trigger.id, secret, '{"event":"x"}');
        expect(fire.status()).toBe(404);
    });

    test("cross-user isolation: every management route on another user's trigger → 404", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const intruder = await registerUserViaAPI(request);
        const { trigger } = await createTriggerViaAPI(request, owner.access_token, {
            name: `Private ${stamp()}`,
        });
        const iH = authedHeaders(intruder.access_token);
        expect(
            (await request.get(`${TRIGGERS_BASE}/${trigger.id}`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${TRIGGERS_BASE}/${trigger.id}`, {
                    headers: iH,
                    data: { name: 'hijack' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (
                await request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, { headers: iH })
            ).status(),
        ).toBe(404);
        expect(
            (await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, { headers: iH })).status(),
        ).toBe(404);
        expect(
            (await request.delete(`${TRIGGERS_BASE}/${trigger.id}`, { headers: iH })).status(),
        ).toBe(404);
    });
});

test.describe('Inbound Triggers — the PUBLIC HMAC fire endpoint', () => {
    test('a correctly-signed fire → 200 { ok, taskId, taskSlug } and spawns a real Task from the template', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Nightly ${stamp()}`,
            taskTitleTemplate: 'Run: {name}',
        });
        const body = '{"event":"nightly.tick","data":{"n":1}}';
        const fire = await fireTrigger(request, trigger.id, secret, body);
        expect(fire.status(), `fire body=${await fire.text().catch(() => '')}`).toBe(200);
        const result = await fire.json();
        expect(result.ok).toBe(true);
        expect(result.taskId).toMatch(UUID_RE);
        expect(typeof result.taskSlug).toBe('string');

        // The spawned Task is real: it shows up in the owner's task list with the templated title.
        const tasks = await request.get(`${API_BASE}/api/tasks?limit=100`, {
            headers: authedHeaders(user.access_token),
        });
        expect(tasks.status()).toBe(200);
        const rows = (await tasks.json()).data as Array<{ id: string; title: string }>;
        const spawned = rows.find((t) => t.id === result.taskId);
        expect(spawned, 'spawned task should be listed').toBeTruthy();
        expect(spawned!.title).toContain(trigger.name);
    });

    test('fireCount increments and lastFiredAt stamps after a successful fire', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Counter ${stamp()}`,
        });
        expect(trigger.fireCount).toBe(0);
        const r1 = await fireTrigger(request, trigger.id, secret, '{"a":1}');
        expect(r1.status()).toBe(200);
        const after = await request.get(`${TRIGGERS_BASE}/${trigger.id}`, {
            headers: authedHeaders(user.access_token),
        });
        const view = await after.json();
        expect(view.fireCount).toBeGreaterThanOrEqual(1);
        expect(view.lastFiredAt).not.toBeNull();
    });

    test('bad signature, missing headers, and stale timestamp all → 401 (constant-shape)', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Guarded ${stamp()}`,
        });
        const body = '{"x":1}';

        // Bad signature.
        expect(
            (
                await fireTrigger(request, trigger.id, secret, body, { signature: 'deadbeef' })
            ).status(),
        ).toBe(401);
        // Missing headers entirely.
        const noHeaders = await request.post(`${TRIGGERS_BASE}/${trigger.id}/fire`, {
            headers: { 'content-type': 'application/json' },
            data: body,
        });
        expect(noHeaders.status()).toBe(401);
        // Stale timestamp (10 minutes ago) even with an otherwise-valid signature over it.
        const staleTs = String(Math.floor(Date.now() / 1000) - 600);
        const staleSig = signPayload(secret, staleTs, body);
        expect(
            (
                await fireTrigger(request, trigger.id, secret, body, {
                    timestamp: staleTs,
                    signature: staleSig,
                })
            ).status(),
        ).toBe(401);
    });

    test('unknown id → 404; malformed id → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `NF ${stamp()}`,
        });
        expect((await fireTrigger(request, UNKNOWN_UUID, secret, '{"x":1}')).status()).toBe(404);
        const malformed = await request.post(`${TRIGGERS_BASE}/not-a-uuid/fire`, {
            headers: {
                'content-type': 'application/json',
                'x-everworks-timestamp': nowEpochSeconds(),
                'x-everworks-signature': 'x',
            },
            data: '{"x":1}',
        });
        expect(malformed.status()).toBe(400);
    });

    test('pause → fire 409 → resume → fire 200', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Toggle ${stamp()}`,
        });
        const H = authedHeaders(user.access_token);

        const pause = await request.post(`${TRIGGERS_BASE}/${trigger.id}/pause`, { headers: H });
        expect(pause.status()).toBe(200);
        expect((await fireTrigger(request, trigger.id, secret, '{"x":1}')).status()).toBe(409);

        const resume = await request.post(`${TRIGGERS_BASE}/${trigger.id}/resume`, { headers: H });
        expect(resume.status()).toBe(200);
        expect((await fireTrigger(request, trigger.id, secret, '{"x":1}')).status()).toBe(200);
    });

    test('rotate-secret: the new secret verifies AND the previous secret still verifies within the grace window', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret: oldSecret } = await createTriggerViaAPI(
            request,
            user.access_token,
            { name: `Rotate ${stamp()}` },
        );
        const rotate = await request.post(`${TRIGGERS_BASE}/${trigger.id}/rotate-secret`, {
            headers: authedHeaders(user.access_token),
        });
        expect(rotate.status()).toBe(200);
        const { secret: newSecret } = await rotate.json();
        expect(newSecret).not.toBe(oldSecret);

        // New secret fires fine.
        expect((await fireTrigger(request, trigger.id, newSecret, '{"n":1}')).status()).toBe(200);
        // Old secret still verifies during the 24h rotation grace.
        expect((await fireTrigger(request, trigger.id, oldSecret, '{"n":2}')).status()).toBe(200);
    });

    test('an oversized payload (>64 KB) with a valid signature → 400', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const { trigger, secret } = await createTriggerViaAPI(request, user.access_token, {
            name: `Big ${stamp()}`,
        });
        const big = `{"blob":"${'x'.repeat(70_000)}"}`;
        const fire = await fireTrigger(request, trigger.id, secret, big);
        expect(fire.status()).toBe(400);
    });
});
