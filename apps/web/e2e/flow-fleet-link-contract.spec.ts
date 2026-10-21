import { test, expect } from '@playwright/test';
import { FLEET_LINK_CLOSE_CODES, FLEET_LINK_TOKEN_TTL_SEC } from '@ever-works/contracts';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import {
    FLEET_LINK_ON,
    NO_CONSENTS,
    beatWithConsents,
    enrollLinkNode,
    helloFor,
    mintLinkToken,
    openLinkSocket,
} from './helpers/fleet-link';

/**
 * Fleet node link (FL-02, T-18, CONTRACTS §3.1, spec FR-3 – FR-5, U2, U3) — the
 * link's API contract walked against a REAL enrolled node, the way
 * `apps/node`'s link client walks it:
 *
 *   POST /api/fleet/link-token  201 { token, wsPath: '/ws/fleet/link', expiresInSec: 300 }
 *                               401 for every bad credential, one message
 *                               404 while the deployment does not accept links
 *   WS   /ws/fleet/link         first frame `link.hello` (token inside) → `link.ready`
 *                               a used, foreign or bad token → close 4001 (one code)
 *                               no consent that opens a link → close 4012
 *
 * and the node view the computer page reads (`GET /api/fleet/nodes/:id`)
 * reporting the link from the platform's own socket state (FR-42).
 *
 * Skips unless the API under test runs with `FLEET_NODE_LINK_ENABLED=true`;
 * the flag-off case runs only when it is off.
 */

const WORK_AND_MANAGE = { ...NO_CONSENTS, work: true, manage: true };

test.describe('Fleet node link — link token and hello/ready (CONTRACTS §3.1)', () => {
    test.skip(!FLEET_LINK_ON, 'FLEET_NODE_LINK_ENABLED is not on for this run');

    test('a node mints a single-use five-minute token; bad credentials are one 401', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, WORK_AND_MANAGE);

        const minted = await mintLinkToken(request, node);
        expect(minted.status(), `link-token body=${await minted.text().catch(() => '')}`).toBe(201);
        const grant = (await minted.json()) as {
            token: unknown;
            wsPath: unknown;
            expiresInSec: unknown;
        };
        expect(typeof grant.token).toBe('string');
        expect((grant.token as string).length).toBeGreaterThan(16);
        expect(grant.wsPath).toBe('/ws/fleet/link');
        expect(grant.expiresInSec).toBe(FLEET_LINK_TOKEN_TTL_SEC);
        // The node credential never comes back.
        expect(JSON.stringify(grant)).not.toContain(node.secret);

        const wrongSecret = await mintLinkToken(request, {
            nodeId: node.nodeId,
            secret: 'b'.repeat(43),
        });
        const unknownNode = await mintLinkToken(request, {
            nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            secret: node.secret,
        });
        expect(wrongSecret.status()).toBe(401);
        expect(unknownNode.status()).toBe(401);
        expect(((await wrongSecret.json()) as { message?: unknown }).message).toEqual(
            ((await unknownNode.json()) as { message?: unknown }).message,
        );
    });

    test('hello → ready; the computer page then reads the link as connected (FR-4, FR-42)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, WORK_AND_MANAGE);
        const { token } = (await (await mintLinkToken(request, node)).json()) as { token: string };

        const link = await openLinkSocket();
        try {
            link.send(helloFor(node, token, WORK_AND_MANAGE));
            const ready = await link.until('link.ready');
            expect(typeof ready.linkGeneration).toBe('number');
            expect(ready.linkGeneration as number).toBeGreaterThanOrEqual(1);
            expect(typeof ready.serverTime).toBe('string');
            expect(ready.limits).toMatchObject({ maxChannels: 64 });
            expect(ready.resumed).toEqual([]);

            const detail = await request.get(`${API_BASE}/api/fleet/nodes/${node.nodeId}`, {
                headers: authedHeaders(u.access_token),
            });
            expect(detail.status()).toBe(200);
            const view = ((await detail.json()) as { node: { link?: Record<string, unknown> } })
                .node;
            expect(view.link?.state).toBe('connected');
            expect(view.link?.linkGeneration).toBe(ready.linkGeneration);
        } finally {
            link.close();
        }
    });

    test('a token presented twice is refused the second time with the one auth close (U3)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, WORK_AND_MANAGE);
        const { token } = (await (await mintLinkToken(request, node)).json()) as { token: string };

        const first = await openLinkSocket();
        try {
            first.send(helloFor(node, token, WORK_AND_MANAGE));
            await first.until('link.ready');
        } finally {
            first.close();
        }

        const replay = await openLinkSocket();
        replay.send(helloFor(node, token, WORK_AND_MANAGE));
        expect((await replay.closed()).code).toBe(FLEET_LINK_CLOSE_CODES.auth);
    });

    test('a token for node A presented as node B is refused with the same close (U3)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const a = await enrollLinkNode(request, u.access_token);
        const b = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, a, WORK_AND_MANAGE);
        await beatWithConsents(request, b, WORK_AND_MANAGE);
        const { token } = (await (await mintLinkToken(request, a)).json()) as { token: string };

        const link = await openLinkSocket();
        link.send(helloFor(b, token, WORK_AND_MANAGE));
        expect((await link.closed()).code).toBe(FLEET_LINK_CLOSE_CODES.auth);
    });

    test('a hello with no consent that opens a link is refused 4012 (FR-1)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, NO_CONSENTS);
        const { token } = (await (await mintLinkToken(request, node)).json()) as { token: string };

        const link = await openLinkSocket();
        link.send(helloFor(node, token, NO_CONSENTS));
        expect((await link.closed()).code).toBe(FLEET_LINK_CLOSE_CODES.noConsent);
    });

    test('a first frame that is not a hello is refused with the auth close', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        await beatWithConsents(request, node, WORK_AND_MANAGE);

        const link = await openLinkSocket();
        link.send({ type: 'link.ping', t: Date.now() });
        expect((await link.closed()).code).toBe(FLEET_LINK_CLOSE_CODES.auth);
    });

    test('an unknown operation id is not found (CONTRACTS §11.2)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/fleet/operations/op-does-not-exist`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(404);
    });
});

test.describe('Fleet node link — switched off (U2)', () => {
    test.skip(FLEET_LINK_ON, 'FLEET_NODE_LINK_ENABLED is on for this run');
    test.skip(process.env.FLEET_ENABLED === 'false', 'Fleet itself is off for this run');

    test('the link-token route answers 404 while the deployment does not accept links', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const node = await enrollLinkNode(request, u.access_token);
        const res = await mintLinkToken(request, node);
        expect(res.status()).toBe(404);
    });
});
