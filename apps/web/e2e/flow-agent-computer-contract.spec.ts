import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent computers — the owner-facing and machine-facing API contract of a
 * live view, in the style of `flow-terminal-attach-contract.spec.ts`.
 *
 * ── Owner routes (apps/api/src/computer/computer.controller.ts) ──────
 *   GET    /api/agents/:id/computer/nodes                   → 200 ComputerNodeOption[]
 *   POST   /api/agents/:id/computer/sessions                → 202 { sessionId } | named refusal
 *   GET    /api/agents/:id/computer/sessions/:sessionId     → 200 view + relay status
 *   POST   /api/agents/:id/computer/sessions/:id/attach-token → 201 { token, wsPath }
 *   DELETE /api/agents/:id/computer/sessions/:sessionId     → 204
 *
 * ── Machine routes ──────────────────────────────────────────────────
 *   POST /api/fleet/jobs/lease { kinds | excludeKinds }     the attended lane's filter
 *   POST /api/internal/computer/:sessionId/frames           node credential, same 401 for a foreign view
 *
 * No daemon is needed: a node is enrolled through the public protocol with
 * the capability tags an attended machine advertises, and this spec plays
 * the machine's half itself. An install with no fleet runtime wired answers
 * the open with 503 — the spec then asserts that refusal and skips the rest,
 * rather than pretending a runtime exists.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function enrollNode(
    request: APIRequestContext,
    user: RegisteredUser,
    capabilities: string[],
): Promise<{ nodeId: string; secret: string; name: string }> {
    const name = `Computer ${uniq()}`;
    const minted = await request.post(`${API_BASE}/api/fleet/nodes/enrollment-token`, {
        headers: authedHeaders(user.access_token),
        data: { name, kind: 'desktop-node' },
    });
    expect(minted.status(), `mint body=${await minted.text().catch(() => '')}`).toBe(201);
    const { token } = await minted.json();
    const enrolled = await request.post(`${API_BASE}/api/fleet/enroll`, {
        data: { token, platform: 'linux/x64', version: '1.0.0', capabilities },
    });
    expect(enrolled.status(), `enroll body=${await enrolled.text().catch(() => '')}`).toBe(201);
    const body = await enrolled.json();
    return { nodeId: body.nodeId, secret: body.secret, name };
}

function computerBase(agentId: string): string {
    return `${API_BASE}/api/agents/${agentId}/computer`;
}

test.describe('agent computer — owner contract', () => {
    test('a fresh account has no computers, and opening a view names that reason', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `computer-agent-${uniq()}`,
        });

        const nodes = await request.get(`${computerBase(agent.id)}/nodes`, {
            headers: authedHeaders(user.access_token),
        });
        expect(nodes.status(), `nodes body=${await nodes.text().catch(() => '')}`).toBe(200);
        expect(await nodes.json()).toEqual([]);

        const open = await request.post(`${computerBase(agent.id)}/sessions`, {
            headers: authedHeaders(user.access_token),
            data: {},
        });
        expect(open.status(), `open body=${await open.text().catch(() => '')}`).toBe(409);
        expect((await open.json()).reason).toBe('no-nodes');
    });

    test('lists each computer with the channels it can serve, or the one reason it cannot be watched', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `computer-agent-${uniq()}`,
        });
        const unattended = await enrollNode(request, user, ['terminal', 'workspace', 'browser']);
        const attended = await enrollNode(request, user, [
            'terminal',
            'workspace',
            'browser',
            'attended',
            'screen',
        ]);
        const headless = await enrollNode(request, user, ['terminal', 'workspace', 'attended']);

        const res = await request.get(`${computerBase(agent.id)}/nodes`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        const byId = new Map(rows.map((row) => [row.id, row]));

        expect(byId.get(unattended.nodeId)).toMatchObject({
            watchable: false,
            unwatchableReason: 'not-attended',
            servableChannels: [],
        });
        expect(byId.get(attended.nodeId)).toMatchObject({
            watchable: true,
            unwatchableReason: null,
            servableChannels: ['screen', 'terminal'],
        });
        // Display-less but attended: watchable on its terminal, with the screen's reason beside it.
        expect(byId.get(headless.nodeId)).toMatchObject({
            watchable: true,
            servableChannels: ['terminal'],
            channelReasons: { screen: 'no-browser' },
        });
    });

    test('another owner’s Agent answers exactly like one that does not exist', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, owner.access_token, {
            name: `computer-agent-${uniq()}`,
        });

        const foreign = await request.get(`${computerBase(agent.id)}/nodes`, {
            headers: authedHeaders(stranger.access_token),
        });
        const unknown = await request.get(`${computerBase(UNKNOWN_UUID)}/nodes`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(foreign.status()).toBe(404);
        expect(unknown.status()).toBe(404);
    });

    test('a view opens on an attended computer, is leased only by its live-view lane, and accepts that machine’s frames', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const agent = await createAgentViaAPI(request, user.access_token, {
            name: `computer-agent-${uniq()}`,
        });
        const node = await enrollNode(request, user, [
            'terminal',
            'workspace',
            'browser',
            'attended',
            'screen',
        ]);

        const open = await request.post(`${computerBase(agent.id)}/sessions`, {
            headers: authedHeaders(user.access_token),
            data: { nodeId: node.nodeId, channels: ['screen'], quality: 'smooth' },
        });
        expect([202, 503], `open body=${await open.text().catch(() => '')}`).toContain(
            open.status(),
        );
        test.skip(open.status() === 503, 'no fleet runtime is wired on this install');
        const { sessionId } = await open.json();
        expect(typeof sessionId).toBe('string');

        const token = await request.post(
            `${computerBase(agent.id)}/sessions/${sessionId}/attach-token`,
            {
                headers: authedHeaders(user.access_token),
            },
        );
        expect(token.status()).toBe(201);
        const minted = await token.json();
        expect(minted.wsPath).toBe(`/ws/computer/${sessionId}`);
        expect(minted.wsPath).not.toContain(minted.token);

        // The work lane never sees a live view; the live-view lane does.
        const workLane = await request.post(`${API_BASE}/api/fleet/jobs/lease`, {
            data: {
                nodeId: node.nodeId,
                secret: node.secret,
                max: 4,
                excludeKinds: ['computer-session'],
            },
        });
        expect(workLane.status()).toBe(200);
        expect(
            ((await workLane.json()).jobs as Array<{ kind: string }>).some(
                (job) => job.kind === 'computer-session',
            ),
        ).toBe(false);

        const viewLane = await request.post(`${API_BASE}/api/fleet/jobs/lease`, {
            data: { nodeId: node.nodeId, secret: node.secret, max: 1, kinds: ['computer-session'] },
        });
        expect(viewLane.status()).toBe(200);
        const jobs = (await viewLane.json()).jobs as Array<{
            kind: string;
            payload: Record<string, unknown>;
        }>;
        expect(jobs).toHaveLength(1);
        expect(jobs[0].kind).toBe('computer-session');
        expect(jobs[0].payload).toMatchObject({
            sessionId,
            nodeId: node.nodeId,
            channels: ['screen'],
            quality: 'smooth',
        });

        const published = await request.post(
            `${API_BASE}/api/internal/computer/${sessionId}/frames`,
            {
                data: {
                    nodeId: node.nodeId,
                    secret: node.secret,
                    frames: [
                        {
                            kind: 'stats',
                            nodeLocalTime: '2026-09-13T09:41:07+00:00',
                            quality: 'smooth',
                            effectiveQuality: 'smooth',
                            fps: 1,
                            backlog: 0,
                            bytesOut: 0,
                        },
                        {
                            kind: 'frame',
                            seq: 1,
                            keyframe: true,
                            width: 2,
                            height: 2,
                            mime: 'image/jpeg',
                            data: 'QUJD',
                        },
                    ],
                },
            },
        );
        expect(published.status(), `frames body=${await published.text().catch(() => '')}`).toBe(
            202,
        );
        expect(await published.json()).toMatchObject({ accepted: 2, ended: false });

        const view = await request.get(`${computerBase(agent.id)}/sessions/${sessionId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(view.status()).toBe(200);
        expect(await view.json()).toMatchObject({
            id: sessionId,
            status: 'live',
            quality: 'smooth',
        });

        // A different machine's credential gets the same 401 as an unknown one.
        const other = await enrollNode(request, user, ['terminal', 'workspace', 'attended']);
        const foreign = await request.post(
            `${API_BASE}/api/internal/computer/${sessionId}/frames`,
            {
                data: { nodeId: other.nodeId, secret: other.secret, frames: [] },
            },
        );
        expect(foreign.status()).toBe(401);

        const closed = await request.delete(`${computerBase(agent.id)}/sessions/${sessionId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(closed.status()).toBe(204);
        const after = await request.get(`${computerBase(agent.id)}/sessions/${sessionId}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(await after.json()).toMatchObject({
            status: 'ended',
            closeReason: 'closed-by-user',
        });
    });
});
