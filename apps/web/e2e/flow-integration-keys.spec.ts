import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';

/**
 * flow-integration-keys.spec.ts — EW-P1-2 integration keys (`ew_int_…`) end to end
 * against the real stack (real DB, real guards, real migration).
 *
 * Spec: docs/specs/features/integration-keys/spec.md
 *
 *   - the workspace owner creates an integration key pinned to one organization;
 *   - GET /api/integrations/v1/whoami answers with the key, tenant, pins and scopes;
 *   - a route without @RequireScopes is 403 scope_missing (deny by default);
 *   - POST /api/tasks needs a pinned org (403 org_not_pinned without one), then creates a
 *     Task attributed to the integration (createdByType 'integration', createdById = key id);
 *   - X-Act-As-User = a real member makes the Task theirs; a stranger is 403 act_as_forbidden;
 *   - key management is closed to integration keys; minting with a personal key is refused;
 *   - rotation keeps the id and the old secret through the grace period; revoke → 401.
 */

const KEYS = `${API_BASE}/api/auth/api-keys`;
const WHOAMI = `${API_BASE}/api/integrations/v1/whoami`;
const TASKS = `${API_BASE}/api/tasks`;

async function createIntegrationKey(
    request: APIRequestContext,
    token: string,
    organizationIds: string[],
    scopes: string[] = ['org:read', 'tasks:read', 'tasks:write'],
) {
    const res = await request.post(`${KEYS}/integration`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: {
            name: `Ever Gauzy e2e ${Date.now()}`,
            integrationKind: 'ever-gauzy',
            scopes,
            organizationIds,
        },
        failOnStatusCode: false,
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
}

test.describe('Integration keys (EW-P1-2)', () => {
    test('create → whoami → pinned, attributed, act-as task writes → forbidden routes → rotate → revoke', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `Gauzy E2E ${Date.now()}`,
        );

        // ── create ──────────────────────────────────────────────────────────
        const created = await createIntegrationKey(request, owner.access_token, [org.id]);
        if (created.status === 404) {
            test.skip(true, 'integration keys are not deployed on this stack');
            return;
        }
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const key: string = created.body.key;
        const keyId: string = created.body.id;
        expect(key).toMatch(/^ew_int_[0-9a-f]{64}$/);
        expect(created.body.organizations).toEqual([
            { id: org.id, slug: org.slug, displayName: org.displayName },
        ]);

        // A personal key can never mint one.
        const personal = await request.post(KEYS, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { name: 'personal' },
        });
        expect(personal.status()).toBe(201);
        const viaPersonal = await request.post(`${KEYS}/integration`, {
            headers: {
                'x-api-key': (await personal.json()).key,
                'content-type': 'application/json',
            },
            data: { name: 'x', scopes: ['tasks:read'], organizationIds: [org.id] },
            failOnStatusCode: false,
        });
        expect(viaPersonal.status()).toBe(403);

        // ── whoami ──────────────────────────────────────────────────────────
        const who = await request.get(WHOAMI, { headers: { Authorization: `Bearer ${key}` } });
        expect(who.status()).toBe(200);
        const whoBody = await who.json();
        expect(whoBody).toMatchObject({
            keyId,
            integrationKind: 'ever-gauzy',
            tenant: { id: org.tenantId },
            organizations: [{ id: org.id, slug: org.slug }],
            apiVersion: '1',
        });
        expect(whoBody.scopes).toEqual(['org:read', 'tasks:read', 'tasks:write']);

        // ── deny by default ─────────────────────────────────────────────────
        const list = await request.get(TASKS, {
            headers: { 'x-api-key': key, 'X-Scope-Slug': org.slug },
            failOnStatusCode: false,
        });
        expect(list.status()).toBe(403);
        expect((await list.json()).error.code).toBe('scope_missing');

        // ── org pin ─────────────────────────────────────────────────────────
        const unpinned = await request.post(TASKS, {
            headers: { 'x-api-key': key, 'content-type': 'application/json' },
            data: { title: 'no org' },
            failOnStatusCode: false,
        });
        expect(unpinned.status()).toBe(403);
        expect((await unpinned.json()).error.code).toBe('org_not_pinned');

        // ── attributed write ────────────────────────────────────────────────
        const task = await request.post(TASKS, {
            headers: {
                'x-api-key': key,
                'X-Scope-Slug': org.slug,
                'X-Sync-Origin': 'gauzy:e2e',
                'content-type': 'application/json',
            },
            data: { title: 'Created by Ever Gauzy' },
        });
        expect(task.status(), await task.text()).toBe(201);
        const taskBody = await task.json();
        expect(taskBody).toMatchObject({
            userId: owner.user.id,
            organizationId: org.id,
            createdByType: 'integration',
            createdById: keyId,
        });

        // D9 — an integration cannot schedule a run.
        const scheduled = await request.post(TASKS, {
            headers: {
                'x-api-key': key,
                'X-Scope-Slug': org.slug,
                'content-type': 'application/json',
            },
            data: {
                title: 'scheduled',
                scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
            failOnStatusCode: false,
        });
        expect(scheduled.status()).toBe(422);
        expect((await scheduled.json()).error.code).toBe('domain_rule');

        // ── act-as ──────────────────────────────────────────────────────────
        const asOwner = await request.post(TASKS, {
            headers: {
                'x-api-key': key,
                'X-Organization-Id': org.id,
                'X-Act-As-User': owner.user.id,
                'content-type': 'application/json',
            },
            data: { title: 'Created for a person' },
        });
        expect(asOwner.status(), await asOwner.text()).toBe(201);
        expect(await asOwner.json()).toMatchObject({
            createdByType: 'user',
            createdById: owner.user.id,
        });

        const stranger = await registerUserViaAPI(request);
        const asStranger = await request.post(TASKS, {
            headers: {
                'x-api-key': key,
                'X-Scope-Slug': org.slug,
                'X-Act-As-User': stranger.user.id,
                'content-type': 'application/json',
            },
            data: { title: 'nope' },
            failOnStatusCode: false,
        });
        expect(asStranger.status()).toBe(403);
        expect((await asStranger.json()).error.code).toBe('act_as_forbidden');

        // ── comment as the integration ──────────────────────────────────────
        const comment = await request.post(`${TASKS}/${taskBody.id}/chat`, {
            headers: {
                'x-api-key': key,
                'X-Scope-Slug': org.slug,
                'content-type': 'application/json',
            },
            data: { body: 'Synced from Gauzy' },
        });
        expect(comment.status(), await comment.text()).toBe(201);
        expect(await comment.json()).toMatchObject({ authorType: 'integration', authorId: keyId });

        // ── forbidden routes ────────────────────────────────────────────────
        for (const [method, url] of [
            ['get', KEYS],
            ['get', `${KEYS}/integration`],
            ['get', `${API_BASE}/api/account/export`],
        ] as const) {
            const res = await request[method](url, {
                headers: { 'x-api-key': key, 'X-Scope-Slug': org.slug },
                failOnStatusCode: false,
            });
            expect(res.status(), `${method} ${url}`).toBe(403);
        }

        // ── rotate ──────────────────────────────────────────────────────────
        const rotated = await request.post(`${KEYS}/${keyId}/rotate`, {
            headers: { ...authedHeaders(owner.access_token), 'content-type': 'application/json' },
            data: { graceHours: 1 },
        });
        expect(rotated.status()).toBe(200);
        const rotatedBody = await rotated.json();
        expect(rotatedBody.id).toBe(keyId);
        for (const secret of [key, rotatedBody.key]) {
            const res = await request.get(WHOAMI, { headers: { 'x-api-key': secret } });
            expect(res.status(), 'old and new secret both work during the grace period').toBe(200);
        }

        // ── revoke ──────────────────────────────────────────────────────────
        const revoke = await request.delete(`${KEYS}/${keyId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(revoke.status()).toBe(200);
        for (const secret of [key, rotatedBody.key]) {
            const res = await request.get(WHOAMI, {
                headers: { 'x-api-key': secret },
                failOnStatusCode: false,
            });
            expect(res.status()).toBe(401);
            expect((await res.json()).error.code).toBe('invalid_key');
        }
    });

    test('only the workspace owner creates keys, pinned to their own organizations', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            owner.access_token,
            `Gauzy Pins ${Date.now()}`,
        );
        const otherOrg = await createOrganizationViaAPI(
            request,
            other.access_token,
            `Other ${Date.now()}`,
        );

        const foreign = await createIntegrationKey(request, owner.access_token, [otherOrg.id]);
        if (foreign.status === 404) {
            test.skip(true, 'integration keys are not deployed on this stack');
            return;
        }
        expect(foreign.status).toBe(400);

        const forbiddenScope = await createIntegrationKey(
            request,
            owner.access_token,
            [org.id],
            ['goals:activate'],
        );
        expect(forbiddenScope.status).toBe(400);

        // A user with no workspace of their own cannot create one.
        const loner = await registerUserViaAPI(request);
        const noTenant = await createIntegrationKey(request, loner.access_token, [org.id]);
        expect(noTenant.status).toBe(403);
    });
});
