import {
    ConflictException,
    HttpException,
    HttpStatus,
    NotFoundException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import type { AgentsService } from '@ever-works/agent/agents';
import type { ComputerSessionService, NodeAgentProfileService } from '@ever-works/agent/computer';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerController } from './computer.controller';
import { ComputerRelayRegistry } from './computer-relay.registry';

/**
 * The owner-facing live-view routes. What they owe the owner, pinned:
 * another owner's Agent or session is indistinguishable from one that does
 * not exist; every refusal has its status AND says why; a browser can only
 * ever be minted a watching token; and the throttles are where the spec put
 * them.
 */

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const NODE = '3a000000-0000-4000-8000-000000000001';
const AUTH = { userId: 'user-1' } as AuthenticatedUser;

const VIEW = {
    id: SESSION,
    agentId: AGENT,
    nodeId: NODE,
    openedByUserId: 'user-1',
    runId: null,
    channels: ['screen'],
    activeChannel: 'screen',
    quality: 'sharp',
    status: 'requested',
    closeReason: null,
    controlSpans: [],
    recorded: false,
    recordingSkippedReason: null,
    frameCount: 0,
    bytesOut: 0,
    lastFrameAt: null,
    startedAt: null,
    endedAt: null,
    createdAt: '2026-09-13T10:00:00.000Z',
};

function build() {
    const agents = {
        getOne: jest.fn(async () => ({ id: AGENT, name: 'Ops', organizationId: 'org-1' })),
    };
    const sessions = {
        listNodeOptions: jest.fn(async () => []),
        open: jest.fn(async () => ({ opened: VIEW })),
        getForOwner: jest.fn(async () => VIEW),
        updateForOwner: jest.fn(
            async (_u: string, _a: string, _s: string, patch: { quality?: string }) => ({
                ...VIEW,
                ...patch,
            }),
        ),
        closeForOwner: jest.fn(async () => true),
    };
    const profiles = {
        getView: jest.fn(async () => null),
        reset: jest.fn(async () => ({ refused: 'name-mismatch' })),
    };
    const signer = new TerminalAttachService();
    const relay = new ComputerRelayRegistry();
    const controller = new ComputerController(
        agents as unknown as AgentsService,
        sessions as unknown as ComputerSessionService,
        profiles as unknown as NodeAgentProfileService,
        new ComputerAttachService(signer),
        relay,
    );
    return { controller, agents, sessions, profiles, relay, signer };
}

async function statusOf(
    promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        const http = error as HttpException;
        const response = http.getResponse();
        return {
            status: http.getStatus(),
            body: (typeof response === 'string' ? { message: response } : response) as Record<
                string,
                unknown
            >,
        };
    }
    throw new Error('expected a refusal');
}

describe('ComputerController — authorization', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-controller-spec-secret';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('404s every route for another owner’s (or an unknown) Agent before touching a session', async () => {
        const { controller, agents, sessions, profiles } = build();
        agents.getOne.mockRejectedValue(new NotFoundException(`Agent ${AGENT} not found`));

        const calls: Array<Promise<unknown>> = [
            controller.listNodes(AUTH, AGENT),
            controller.openSession(AUTH, AGENT, {}),
            controller.getSession(AUTH, AGENT, SESSION),
            controller.updateSession(AUTH, AGENT, SESSION, { quality: 'steady' }),
            controller.closeSession(AUTH, AGENT, SESSION),
            controller.mintAttachToken(AUTH, AGENT, SESSION),
            controller.refresh(AUTH, AGENT, SESSION),
            controller.getProfile(AUTH, AGENT, NODE),
            controller.resetProfile(AUTH, AGENT, { nodeId: NODE, confirmAgentName: 'Ops' }),
        ];
        for (const call of calls) {
            await expect(call).rejects.toBeInstanceOf(NotFoundException);
        }
        expect(sessions.open).not.toHaveBeenCalled();
        expect(sessions.getForOwner).not.toHaveBeenCalled();
        expect(profiles.reset).not.toHaveBeenCalled();
    });

    it('404s another owner’s session exactly like an unknown one', async () => {
        const { controller, sessions } = build();
        sessions.getForOwner.mockResolvedValue(null);
        sessions.closeForOwner.mockResolvedValue(false);
        sessions.updateForOwner.mockResolvedValue(null);

        await expect(controller.getSession(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.closeSession(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.updateSession(AUTH, AGENT, SESSION, {})).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.mintAttachToken(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.refresh(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('ComputerController — opening a view', () => {
    it('answers 202-shaped with the session id and passes the owner’s Agent to the service', async () => {
        const { controller, sessions } = build();
        const result = await controller.openSession(AUTH, AGENT, {
            nodeId: NODE,
            channels: ['terminal'],
            quality: 'smooth',
        });
        expect(result).toMatchObject({ sessionId: SESSION, status: 'requested' });
        expect(sessions.open).toHaveBeenCalledWith({
            userId: 'user-1',
            agent: { id: AGENT, name: 'Ops', organizationId: 'org-1' },
            nodeId: NODE,
            channels: ['terminal'],
            quality: 'smooth',
        });
    });

    it.each<[string, Record<string, unknown>, number, string]>([
        [
            'the fleet is stopped',
            {
                refused: 'stopped',
                stop: { stopped: true, reason: 'Investigating a runaway job', since: null },
            },
            HttpStatus.CONFLICT,
            'stopped',
        ],
        ['the owner has no machines', { refused: 'no-nodes' }, HttpStatus.CONFLICT, 'no-nodes'],
        [
            'the machine is not theirs',
            { refused: 'node-not-found' },
            HttpStatus.NOT_FOUND,
            'node-not-found',
        ],
        [
            'the machine is paused',
            { refused: 'node-unwatchable', nodeId: NODE, reason: 'paused' },
            HttpStatus.CONFLICT,
            'paused',
        ],
        [
            'the machine is offline',
            { refused: 'node-unwatchable', nodeId: NODE, reason: 'offline' },
            HttpStatus.CONFLICT,
            'offline',
        ],
        [
            'live viewing is switched off',
            { refused: 'node-unwatchable', nodeId: NODE, reason: 'not-attended' },
            HttpStatus.CONFLICT,
            'not-attended',
        ],
        [
            'the machine cannot show a screen',
            {
                refused: 'channel-unavailable',
                nodeId: NODE,
                channel: 'screen',
                reason: 'no-display',
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
            'no-display',
        ],
        [
            'the machine has too many views',
            {
                refused: 'node-session-cap',
                limit: 2,
                sessions: [
                    {
                        sessionId: 's',
                        nodeId: NODE,
                        openedByUserId: 'u',
                        status: 'live',
                        since: null,
                    },
                ],
            },
            HttpStatus.TOO_MANY_REQUESTS,
            'node-session-cap',
        ],
        [
            'the Organization has too many views',
            { refused: 'organization-session-cap', limit: 5, sessions: [] },
            HttpStatus.TOO_MANY_REQUESTS,
            'organization-session-cap',
        ],
        [
            'no fleet runtime is wired',
            { refused: 'dispatcher-unavailable' },
            HttpStatus.SERVICE_UNAVAILABLE,
            'dispatcher-unavailable',
        ],
    ])(
        'refuses when %s, with its status and its reason',
        async (_label, refusal, status, reason) => {
            const { controller, sessions } = build();
            sessions.open.mockResolvedValueOnce(refusal as never);

            const refused = await statusOf(controller.openSession(AUTH, AGENT, {}));

            expect(refused.status).toBe(status);
            expect(refused.body.reason).toBe(reason);
            expect(String(refused.body.message).length).toBeGreaterThan(0);
        },
    );

    it('names the stop reason, the unavailable channel and the existing views in the refusal', async () => {
        const { controller, sessions } = build();
        sessions.open.mockResolvedValueOnce({
            refused: 'stopped',
            stop: { reason: 'Investigating a runaway job' },
        } as never);
        expect((await statusOf(controller.openSession(AUTH, AGENT, {}))).body.message).toContain(
            'Investigating a runaway job',
        );

        sessions.open.mockResolvedValueOnce({
            refused: 'channel-unavailable',
            nodeId: NODE,
            channel: 'terminal',
            reason: 'no-terminal',
        } as never);
        const channel = await statusOf(
            controller.openSession(AUTH, AGENT, { channels: ['terminal'] }),
        );
        expect(channel.body).toMatchObject({ channel: 'terminal', reason: 'no-terminal' });
        expect(channel.body.message).toContain('terminal');

        const holders = [
            {
                sessionId: 's1',
                nodeId: NODE,
                openedByUserId: 'user-1',
                status: 'live',
                since: null,
            },
        ];
        sessions.open.mockResolvedValueOnce({
            refused: 'node-session-cap',
            limit: 2,
            sessions: holders,
        } as never);
        expect((await statusOf(controller.openSession(AUTH, AGENT, {}))).body.sessions).toEqual(
            holders,
        );
    });
});

describe('ComputerController — attach, refresh and quality', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-controller-spec-secret';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('mints a watching token for the live-view socket — never for a terminal', async () => {
        const { controller, signer } = build();
        const result = await controller.mintAttachToken(AUTH, AGENT, SESSION);

        expect(result).toMatchObject({ role: 'viewer', wsPath: `/ws/computer/${SESSION}` });
        expect(new ComputerAttachService(signer).verify(result.token)).toMatchObject({
            userId: 'user-1',
            sessionId: SESSION,
            role: 'viewer',
        });
        expect(signer.verify(result.token)).toMatchObject({ channel: 'computer' });
    });

    it('downgrades every other requested role to viewer — a request can never upgrade', async () => {
        const { controller } = build();
        for (const requested of ['driver', 'worker', 'controller', 'ADMIN', '', undefined]) {
            expect((await controller.mintAttachToken(AUTH, AGENT, SESSION, requested)).role).toBe(
                'viewer',
            );
        }
    });

    it('answers 503 when no attach secret is configured, rather than minting an unsigned token', async () => {
        const { controller } = build();
        delete process.env.TERMINAL_ATTACH_SECRET;
        const savedAuth = process.env.BETTER_AUTH_SECRET;
        const savedAuth2 = process.env.AUTH_SECRET;
        delete process.env.BETTER_AUTH_SECRET;
        delete process.env.AUTH_SECRET;
        try {
            await expect(controller.mintAttachToken(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        } finally {
            if (savedAuth !== undefined) process.env.BETTER_AUTH_SECRET = savedAuth;
            if (savedAuth2 !== undefined) process.env.AUTH_SECRET = savedAuth2;
        }
    });

    it('asks the machine for a picture on refresh, and refuses once the view has ended', async () => {
        const { controller, relay, sessions } = build();
        const node: string[] = [];
        relay.attach(SESSION, { id: 'node', role: 'worker', send: (wire) => node.push(wire) });

        expect(await controller.refresh(AUTH, AGENT, SESSION)).toEqual({ requested: true });
        expect(node.map((wire) => JSON.parse(wire))).toEqual([{ kind: 'refresh' }]);

        sessions.getForOwner.mockResolvedValueOnce({ ...VIEW, status: 'ended' } as never);
        const refused = await statusOf(controller.refresh(AUTH, AGENT, SESSION));
        expect(refused).toMatchObject({
            status: HttpStatus.CONFLICT,
            body: { reason: 'session-ended' },
        });
    });

    it('tells the machine about a quality change', async () => {
        const { controller, relay } = build();
        const node: string[] = [];
        relay.attach(SESSION, { id: 'node', role: 'worker', send: (wire) => node.push(wire) });

        await controller.updateSession(AUTH, AGENT, SESSION, { quality: 'steady' });

        expect(node.map((wire) => JSON.parse(wire))).toEqual([
            { kind: 'quality', quality: 'steady' },
        ]);
    });

    it('merges the persisted view with this replica’s relay status', async () => {
        const { controller } = build();
        const view = await controller.getSession(AUTH, AGENT, SESSION);
        expect(view).toMatchObject({ id: SESSION, live: { exists: false, viewerCount: 0 } });
    });
});

describe('ComputerController — the Agent’s own logins and files', () => {
    it.each<[Record<string, unknown>, abstract new (...args: never[]) => HttpException, string]>([
        [{ refused: 'name-mismatch' }, UnprocessableEntityException, 'name-mismatch'],
        [{ refused: 'run-live' }, ConflictException, 'run-live'],
        [{ refused: 'node-not-found' }, NotFoundException, 'node-not-found'],
        [{ refused: 'profile-not-found' }, NotFoundException, 'profile-not-found'],
    ])('maps a reset refusal %o to its status and reason', async (refusal, type, reason) => {
        const { controller, profiles } = build();
        profiles.reset.mockResolvedValue(refusal as never);
        const call = controller.resetProfile(AUTH, AGENT, {
            nodeId: NODE,
            confirmAgentName: 'Ops',
        });
        await expect(call).rejects.toBeInstanceOf(type);
        const refused = await statusOf(
            controller.resetProfile(AUTH, AGENT, { nodeId: NODE, confirmAgentName: 'Ops' }),
        );
        expect(refused.body.reason).toBe(reason);
    });

    it('404s a profile that does not exist yet', async () => {
        const { controller } = build();
        await expect(controller.getProfile(AUTH, AGENT, NODE)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('ComputerController — throttles', () => {
    it.each<[keyof ComputerController, number]>([
        ['openSession', 10],
        ['refresh', 30],
        ['mintAttachToken', 30],
        ['resetProfile', 10],
    ])('%s is throttled at %d per minute', (method, limit) => {
        const handler = ComputerController.prototype[method];
        expect(Reflect.getMetadata(THROTTLER_LIMIT + 'long', handler)).toBe(limit);
        expect(Reflect.getMetadata(THROTTLER_TTL + 'long', handler)).toBe(60_000);
    });
});
