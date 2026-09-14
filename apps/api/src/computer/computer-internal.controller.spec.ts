import { PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ComputerSessionService, NodeAgentProfileService } from '@ever-works/agent/computer';
import { COMPUTER_MAX_BATCH_FRAMES } from '@ever-works/contracts';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import {
    FLEET_NODE_UNAUTHORIZED_MESSAGE,
    FleetNodeAuthGuard,
    type AuthenticatedFleetNode,
} from '../fleet/guards/fleet-node-auth.guard';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerInternalController } from './computer-internal.controller';
import { ComputerRelayRegistry } from './computer-relay.registry';

/**
 * The machine-facing live-view routes. Pinned: the fleet's own node guard
 * is what authenticates them; a machine can publish only into ITS OWN
 * session and anything else is the guard's exact 401; the batch caps are
 * enforced before a frame is decoded; and a stopped fleet ends the view.
 */

const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const NODE_A: AuthenticatedFleetNode = {
    id: '3a000000-0000-4000-8000-00000000000a',
    userId: 'owner-1',
    organizationId: null,
    capabilities: ['attended', 'screen'],
};
const NODE_B: AuthenticatedFleetNode = { ...NODE_A, id: '3a000000-0000-4000-8000-00000000000b' };
const CREDENTIAL = { nodeId: NODE_A.id, secret: 'x'.repeat(32) };

const picture = (seq: number, data = 'aGk=') => ({
    kind: 'frame',
    seq,
    keyframe: true,
    width: 4,
    height: 4,
    mime: 'image/jpeg',
    data,
});

function build(options: { stopped?: boolean; status?: string; expiresAs?: string } = {}) {
    const row = {
        id: SESSION,
        nodeId: NODE_A.id,
        agentId: 'agent-1',
        status: options.status ?? 'requested',
        closeReason: null as string | null,
    };
    const sessions = {
        findForNode: jest.fn(async (sessionId: string, nodeId: string) =>
            sessionId === SESSION && nodeId === NODE_A.id ? row : null,
        ),
        findById: jest.fn(async () => row),
        expireIfDue: jest.fn(async (candidate: typeof row) => {
            if (options.expiresAs && candidate.status !== 'ended') {
                Object.assign(row, { status: 'ended', closeReason: options.expiresAs });
            }
            return row;
        }),
        endIfStopped: jest.fn(async () => {
            if (options.stopped) {
                Object.assign(row, { status: 'ended', closeReason: 'stopped' });
                return true;
            }
            return false;
        }),
        recordPublished: jest.fn(async () => undefined),
        recordNodeReport: jest.fn(async () => undefined),
    };
    const profiles = { recordSelfReport: jest.fn(async () => true) };
    const relay = new ComputerRelayRegistry();
    const signer = new TerminalAttachService();
    const controller = new ComputerInternalController(
        sessions as unknown as ComputerSessionService,
        relay,
        new ComputerAttachService(signer),
        profiles as unknown as NodeAgentProfileService,
    );
    return { controller, sessions, profiles, relay, signer, row };
}

describe('ComputerInternalController — authentication', () => {
    it('is guarded by the fleet switch and the fleet’s own node credential guard', () => {
        expect(Reflect.getMetadata(GUARDS_METADATA, ComputerInternalController)).toEqual([
            FleetEnabledGuard,
            FleetNodeAuthGuard,
        ]);
    });

    it('answers another machine’s session, and an unknown one, with the guard’s exact 401', async () => {
        const { controller, relay } = build();
        const viewer: string[] = [];
        relay.attach(SESSION, { id: 'v', role: 'viewer', send: (wire) => viewer.push(wire) });

        for (const call of [
            controller.publishFrames(NODE_B, SESSION, { ...CREDENTIAL, frames: [picture(0)] }),
            controller.heartbeat(NODE_B, SESSION, { ...CREDENTIAL }),
            controller.mintWorkerToken(NODE_B, SESSION, CREDENTIAL),
            controller.reportProfile(NODE_B, SESSION, {
                ...CREDENTIAL,
                profileKey: 'ab'.repeat(16),
                signedInSiteCount: 1,
                diskBytes: 1,
            }),
            controller.publishFrames(NODE_A, '9f000000-0000-4000-8000-000000000009', {
                ...CREDENTIAL,
                frames: [],
            }),
            controller.publishFrames(NODE_A, 'not-a-uuid', { ...CREDENTIAL, frames: [] }),
        ]) {
            await expect(call).rejects.toThrow(
                new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE),
            );
        }
        expect(viewer).toEqual([]);
    });
});

describe('ComputerInternalController — publishing', () => {
    it('relays pictures to viewers and accounts for them', async () => {
        const { controller, relay, sessions } = build();
        const viewer: Array<Record<string, unknown>> = [];
        relay.attach(SESSION, {
            id: 'v',
            role: 'viewer',
            send: (wire) => viewer.push(JSON.parse(wire)),
        });

        const result = await controller.publishFrames(NODE_A, SESSION, {
            ...CREDENTIAL,
            frames: [
                picture(0),
                picture(1, 'aGVsbG8='),
                { kind: 'pointer', action: 'down', x: 1, y: 1, button: 'left' },
                { kind: 'nope' },
            ],
        });

        expect(result).toEqual({ accepted: 2, dropped: 2, ended: false, closeReason: null });
        expect(viewer.map((frame) => frame.seq)).toEqual([0, 1]);
        expect(sessions.recordPublished).toHaveBeenCalledWith(
            expect.objectContaining({ id: SESSION }),
            {
                frames: 2,
                bytes: 2 + 5,
            },
        );
    });

    it('refuses a batch over the picture cap before decoding anything', async () => {
        const { controller, sessions } = build();
        const frames = Array.from({ length: COMPUTER_MAX_BATCH_FRAMES + 1 }, (_, seq) =>
            picture(seq),
        );
        await expect(
            controller.publishFrames(NODE_A, SESSION, { ...CREDENTIAL, frames }),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(sessions.findForNode).not.toHaveBeenCalled();
    });

    it('refuses a batch whose pictures add up past the byte cap', async () => {
        const { controller } = build();
        const big = 'A'.repeat(360 * 1024);
        await expect(
            controller.publishFrames(NODE_A, SESSION, {
                ...CREDENTIAL,
                frames: [picture(0, big), picture(1, big)],
            }),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('ends the view when the machine publishes its end frame', async () => {
        const { controller, sessions } = build();
        const result = await controller.publishFrames(NODE_A, SESSION, {
            ...CREDENTIAL,
            frames: [{ kind: 'end', reason: 'node-restarted' }],
        });
        expect(result).toMatchObject({ ended: true, closeReason: 'node-restarted' });
        expect(sessions.recordNodeReport).toHaveBeenCalledWith(expect.anything(), {
            status: 'ended',
            closeReason: 'node-restarted',
        });
    });

    it('records the end even when the first attempt to persist it failed — the retry is not refused', async () => {
        const { controller, relay, sessions } = build();
        const viewer: Array<Record<string, unknown>> = [];
        relay.attach(SESSION, {
            id: 'v',
            role: 'viewer',
            send: (wire) => viewer.push(JSON.parse(wire)),
        });
        const batch = {
            ...CREDENTIAL,
            frames: [picture(0), { kind: 'end', reason: 'node-restarted' }],
        };
        sessions.recordNodeReport.mockRejectedValueOnce(new Error('db blip'));

        await expect(controller.publishFrames(NODE_A, SESSION, batch)).rejects.toThrow('db blip');
        // Nothing pinned while the end is not on record, so the retry is still an end.
        expect(relay.getStatus(SESSION).ended).toBe(false);

        const retry = await controller.publishFrames(NODE_A, SESSION, batch);

        expect(retry).toEqual({
            accepted: 1,
            dropped: 1,
            ended: true,
            closeReason: 'node-restarted',
        });
        expect(sessions.recordNodeReport).toHaveBeenCalledTimes(2);
        expect(sessions.recordNodeReport).toHaveBeenLastCalledWith(expect.anything(), {
            status: 'ended',
            closeReason: 'node-restarted',
        });
        expect(relay.getStatus(SESSION)).toMatchObject({
            ended: true,
            endReason: 'node-restarted',
        });
        // The picture went out once (its retry is a duplicate seq), then the end.
        expect(viewer.map((frame) => frame.kind)).toEqual(['frame', 'end']);
    });

    it('records the end when accounting for the batch failed first', async () => {
        const { controller, relay, sessions } = build();
        const batch = { ...CREDENTIAL, frames: [picture(0), { kind: 'end', reason: 'error' }] };
        sessions.recordPublished.mockRejectedValueOnce(new Error('db blip'));

        await expect(controller.publishFrames(NODE_A, SESSION, batch)).rejects.toThrow('db blip');
        expect(sessions.recordNodeReport).not.toHaveBeenCalled();

        await expect(controller.publishFrames(NODE_A, SESSION, batch)).resolves.toMatchObject({
            ended: true,
            closeReason: 'error',
        });
        expect(sessions.recordNodeReport).toHaveBeenCalledTimes(1);
        expect(relay.getStatus(SESSION).ended).toBe(true);
    });

    it('relays nothing after the machine’s own end frame, and answers with the reason on record', async () => {
        const { controller, relay, sessions, row } = build();
        const viewer: Array<Record<string, unknown>> = [];
        relay.attach(SESSION, {
            id: 'v',
            role: 'viewer',
            send: (wire) => viewer.push(JSON.parse(wire)),
        });
        // The node named a reason it may not report; the record says what the platform accepted.
        sessions.recordNodeReport.mockImplementationOnce(async () => {
            Object.assign(row, { status: 'ended', closeReason: 'node-unavailable' });
        });

        const result = await controller.publishFrames(NODE_A, SESSION, {
            ...CREDENTIAL,
            frames: [{ kind: 'end', reason: 'closed-by-user' }, picture(0)],
        });

        expect(result).toEqual({
            accepted: 1,
            dropped: 1,
            ended: true,
            closeReason: 'node-unavailable',
        });
        expect(viewer).toEqual([{ kind: 'end', reason: 'node-unavailable' }]);
    });

    it('ends a view no machine claimed in time instead of making it live', async () => {
        const { controller, relay, sessions } = build({ expiresAs: 'abandoned' });
        const viewer: string[] = [];
        relay.attach(SESSION, { id: 'v', role: 'viewer', send: (wire) => viewer.push(wire) });

        const result = await controller.publishFrames(NODE_A, SESSION, {
            ...CREDENTIAL,
            frames: [picture(0)],
        });

        expect(result).toEqual({ accepted: 0, dropped: 1, ended: true, closeReason: 'abandoned' });
        expect(sessions.expireIfDue).toHaveBeenCalledTimes(1);
        expect(sessions.recordPublished).not.toHaveBeenCalled();
        expect(viewer).toEqual([]);
    });

    it('tells the machine to stop, and relays nothing, once the fleet is stopped', async () => {
        const { controller, relay } = build({ stopped: true });
        const viewer: string[] = [];
        relay.attach(SESSION, { id: 'v', role: 'viewer', send: (wire) => viewer.push(wire) });

        const result = await controller.publishFrames(NODE_A, SESSION, {
            ...CREDENTIAL,
            frames: [picture(0)],
        });

        expect(result).toMatchObject({ accepted: 0, ended: true, closeReason: 'stopped' });
        expect(viewer).toEqual([]);
    });
});

describe('ComputerInternalController — lifecycle, worker token and profile', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-internal-spec-secret';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('passes a whitelisted lifecycle report through, and says whether the view has ended', async () => {
        const { controller, sessions } = build();
        const result = await controller.heartbeat(NODE_A, SESSION, {
            ...CREDENTIAL,
            status: 'stalled',
        });
        expect(sessions.recordNodeReport).toHaveBeenCalledWith(expect.anything(), {
            status: 'stalled',
            closeReason: undefined,
        });
        expect(result).toEqual({ ok: true, ended: false, closeReason: null });
    });

    it('ends the view on a heartbeat while the fleet is stopped', async () => {
        const { controller, sessions } = build({ stopped: true });
        const result = await controller.heartbeat(NODE_A, SESSION, {
            ...CREDENTIAL,
            status: 'live',
        });
        expect(result).toEqual({ ok: true, ended: true, closeReason: 'stopped' });
        expect(sessions.recordNodeReport).not.toHaveBeenCalled();
    });

    it('mints the machine a worker token for its own leg of THIS view only', async () => {
        const { controller, signer } = build();
        const { token, wsPath } = await controller.mintWorkerToken(NODE_A, SESSION, CREDENTIAL);
        expect(wsPath).toBe(`/ws/computer/${SESSION}`);
        expect(new ComputerAttachService(signer).verify(token)).toMatchObject({
            sessionId: SESSION,
            role: 'worker',
        });
    });

    it('refuses a worker token for a view that has ended', async () => {
        const { controller } = build({ status: 'ended' });
        await expect(
            controller.mintWorkerToken(NODE_A, SESSION, CREDENTIAL),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a worker token once the fleet is stopped, ending the view instead of minting', async () => {
        const { controller, sessions, row } = build({ stopped: true });
        const mint = jest.spyOn(ComputerAttachService.prototype, 'mint');
        try {
            await expect(controller.mintWorkerToken(NODE_A, SESSION, CREDENTIAL)).rejects.toThrow(
                new UnauthorizedException(FLEET_NODE_UNAUTHORIZED_MESSAGE),
            );
            expect(sessions.endIfStopped).toHaveBeenCalledTimes(1);
            expect(mint).not.toHaveBeenCalled();
            expect(row).toMatchObject({ status: 'ended', closeReason: 'stopped' });
        } finally {
            mint.mockRestore();
        }
    });

    it('refuses a worker token, and says ended on a heartbeat, for a view past its claim timeout', async () => {
        const expired = build({ expiresAs: 'abandoned' });
        await expect(
            expired.controller.mintWorkerToken(NODE_A, SESSION, CREDENTIAL),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        const beat = build({ expiresAs: 'abandoned' });
        await expect(
            beat.controller.heartbeat(NODE_A, SESSION, { ...CREDENTIAL, status: 'live' }),
        ).resolves.toEqual({ ok: true, ended: true, closeReason: 'abandoned' });
        expect(beat.sessions.recordNodeReport).not.toHaveBeenCalled();
    });

    it('records the profile report against the session’s own Agent and the authenticated machine', async () => {
        const { controller, profiles } = build();
        const result = await controller.reportProfile(NODE_A, SESSION, {
            ...CREDENTIAL,
            profileKey: 'ab'.repeat(16),
            signedInSiteCount: 3,
            diskBytes: 1024,
        });
        expect(result).toEqual({ accepted: true });
        expect(profiles.recordSelfReport).toHaveBeenCalledWith({
            nodeId: NODE_A.id,
            agentId: 'agent-1',
            profileKey: 'ab'.repeat(16),
            signedInSiteCount: 3,
            diskBytes: 1024,
        });
    });
});
