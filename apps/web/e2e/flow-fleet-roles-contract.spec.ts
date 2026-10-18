import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import {
    FLEET_HUB_ON,
    enrollFleetNode,
    freshFleetUser,
    signedInFleetUser,
} from './helpers/fleet-hub';

/**
 * Fleet hub (FL-01, T-26, ACC-FL01-14, -16) — the roles contract over HTTP,
 * against REAL accounts and a REAL enrolled node:
 *
 * - a stranger (another account) never sees, lists or acts on a computer:
 *   every read and every lifecycle act answers the 404 of an unknown id
 *   (FR-30, FR-32), and the hub's visible list leaves it out;
 * - a policy change by the owner writes one `node.policy.change` audit row
 *   with the family and the old and new audience (FR-31);
 * - the optional typed name on remove (CONTRACTS §2.2): a wrong one is
 *   `invalid` and deletes nothing; none at all removes exactly as before.
 *
 * Organisation roles (`org-admin`, `org-member`) need a computer bound to an
 * Organization, which nothing in the product can do yet (owner question A17);
 * the derivation and the `machines` gating are pinned by the API and agent
 * specs (`fleet-hub.controller.spec.ts`, `fleet-hub.service.spec.ts`,
 * `fleet-access.integration.spec.ts`) until that binding exists.
 *
 * Skips unless the web server under test runs with `FLEET_HUB_ENABLED=true`.
 */

test.describe('Fleet hub — roles contract', () => {
    test.skip(!FLEET_HUB_ON, 'FLEET_HUB_ENABLED is not on for this run');

    test('a stranger gets the 404 of an unknown id for every read and every act (FR-30, FR-32)', async ({
        request,
    }) => {
        const owner = await freshFleetUser(request);
        const stranger = await freshFleetUser(request);
        const node = await enrollFleetNode(request, owner.access_token);
        const as = authedHeaders(stranger.access_token);
        const base = `${API_BASE}/api/fleet/nodes/${node.nodeId}`;

        expect((await request.get(base, { headers: as })).status()).toBe(404);
        expect((await request.get(`${base}/needs-a-look`, { headers: as })).status()).toBe(404);
        expect((await request.patch(base, { headers: as, data: { name: 'taken' } })).status()).toBe(
            404,
        );
        expect((await request.patch(base, { headers: as, data: { paused: true } })).status()).toBe(
            404,
        );
        expect(
            (await request.post(`${base}/drain`, { headers: as, data: { drain: true } })).status(),
        ).toBe(404);
        expect(
            (
                await request.delete(base, { headers: as, data: { confirmName: node.name } })
            ).status(),
        ).toBe(404);

        const visible = await request.get(`${API_BASE}/api/fleet/nodes?scope=visible`, {
            headers: as,
        });
        expect(visible.status()).toBe(200);
        expect(((await visible.json()) as { id: string }[]).map((row) => row.id)).not.toContain(
            node.nodeId,
        );

        // Nothing the stranger tried changed the node.
        const mine = await request.get(base, { headers: authedHeaders(owner.access_token) });
        expect(mine.status()).toBe(200);
        expect((await mine.json()).node).toMatchObject({ name: node.name, status: 'online' });
    });

    test('a stranger’s browser gets the same 404 page for the computer (FR-30)', async ({
        browser,
        request,
    }) => {
        const owner = await freshFleetUser(request);
        const stranger = await freshFleetUser(request);
        const node = await enrollFleetNode(request, owner.access_token);
        const { page, close } = await signedInFleetUser(browser, stranger);
        try {
            const response = await page.goto(`/en/fleet/computers/${node.nodeId}`);
            expect(response?.status()).toBe(404);
        } finally {
            await close();
        }
    });

    test('a policy change writes one node.policy.change row per family changed (FR-31)', async ({
        request,
    }) => {
        const owner = await freshFleetUser(request);
        const node = await enrollFleetNode(request, owner.access_token);
        const headers = authedHeaders(owner.access_token);
        const base = `${API_BASE}/api/fleet/nodes/${node.nodeId}`;

        const changed = await request.patch(base, {
            headers,
            data: { controlPolicyFamilies: { machines: 'org-admins', logs: 'org-members' } },
        });
        expect(changed.status(), `patch body=${await changed.text().catch(() => '')}`).toBe(200);
        expect((await changed.json()).controlPolicyFamilies).toMatchObject({
            machines: 'org-admins',
            logs: 'org-members',
            view: 'org-members',
            desktop: 'owner',
        });

        const audit = await request.get(`${base}/audit`, { headers });
        expect(audit.status()).toBe(200);
        const rows = (
            (await audit.json()) as { action: string; details?: Record<string, unknown> | null }[]
        ).filter((row) => row.action === 'node.policy.change');
        expect(rows.map((row) => row.details?.family).sort()).toEqual(['logs', 'machines']);
        expect(rows.find((row) => row.details?.family === 'machines')?.details).toMatchObject({
            from: 'owner',
            to: 'org-admins',
        });

        // The same write again changes nothing and writes nothing.
        await request.patch(base, {
            headers,
            data: { controlPolicyFamilies: { machines: 'org-admins' } },
        });
        const again = await request.get(`${base}/audit`, { headers });
        expect(
            ((await again.json()) as { action: string }[]).filter(
                (row) => row.action === 'node.policy.change',
            ),
        ).toHaveLength(2);
    });

    test('remove: a wrong typed name is invalid and deletes nothing; none removes as before (CONTRACTS §2.2)', async ({
        request,
    }) => {
        const owner = await freshFleetUser(request);
        const headers = authedHeaders(owner.access_token);
        const typed = await enrollFleetNode(request, owner.access_token);
        const plain = await enrollFleetNode(request, owner.access_token);

        const wrong = await request.delete(`${API_BASE}/api/fleet/nodes/${typed.nodeId}`, {
            headers,
            data: { confirmName: `${typed.name} (not it)` },
        });
        expect(wrong.status()).toBe(400);
        expect((await wrong.json()).error).toMatchObject({
            code: 'invalid',
            details: { field: 'confirmName' },
        });
        expect(
            (
                await request.get(`${API_BASE}/api/fleet/nodes/${typed.nodeId}`, { headers })
            ).status(),
        ).toBe(200);

        const right = await request.delete(`${API_BASE}/api/fleet/nodes/${typed.nodeId}`, {
            headers,
            data: { confirmName: typed.name },
        });
        expect(right.status()).toBe(204);

        const none = await request.delete(`${API_BASE}/api/fleet/nodes/${plain.nodeId}`, {
            headers,
        });
        expect(none.status()).toBe(204);
    });
});
