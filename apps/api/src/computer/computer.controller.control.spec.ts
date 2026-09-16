import {
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import type { ComputerControlStateView } from '@ever-works/contracts';
import type { AgentsService } from '@ever-works/agent/agents';
import type {
    ComputerControlArbiter,
    ComputerSessionService,
    NodeAgentProfileService,
} from '@ever-works/agent/computer';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerController, controlStateOrThrow } from './computer.controller';
import { ComputerRelayRegistry } from './computer-relay.registry';

/**
 * The take-over routes of the owner-facing controller. What a person taking
 * control depends on, pinned: another owner's Agent or view is
 * indistinguishable from one that does not exist; a refusal by policy is a
 * 403 that names the policy and one because someone else holds control is a
 * 409 that names the holder; a driving token is minted only to the view the
 * arbiter says holds control; and an install without the arbiter says so
 * rather than pretending.
 */

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const OTHER_VIEW = '4b000000-0000-4000-8000-000000000002';
const NODE = '3a000000-0000-4000-8000-000000000001';
const AUTH = { userId: 'user-1' } as AuthenticatedUser;

function state(patch: Partial<ComputerControlStateView> = {}): ComputerControlStateView {
    return {
        nodeId: NODE,
        sessionId: SESSION,
        policy: 'owner',
        canControl: true,
        mode: 'watching',
        holder: null,
        request: null,
        lastRelease: null,
        serverTime: '2026-09-14T09:00:00.000Z',
        ...patch,
    };
}

const HELD_ELSEWHERE = state({
    holder: {
        userId: 'user-1',
        sessionId: OTHER_VIEW,
        since: '2026-09-14T08:59:00.000Z',
        expiresAt: '2026-09-14T09:59:00.000Z',
        idleAt: '2026-09-14T09:09:00.000Z',
        extended: false,
        you: true,
        thisView: false,
    },
});

function build(options: { withControl?: boolean } = {}) {
    const agents = {
        getOne: jest.fn(async () => ({ id: AGENT, name: 'Ops', organizationId: 'org-1' })),
    };
    const sessions = {
        getForOwner: jest.fn(async () => ({ id: SESSION, status: 'live' })),
    };
    const control = {
        getState: jest.fn(async () => state() as ComputerControlStateView | null),
        take: jest.fn(async () => ({ state: state({ mode: 'controlling' }) }) as unknown),
        request: jest.fn(async () => ({ state: state() }) as unknown),
        giveBack: jest.fn(async () => ({ state: state() }) as unknown),
        answer: jest.fn(async () => ({ state: state() }) as unknown),
        keep: jest.fn(async () => ({ state: state({ mode: 'controlling' }) }) as unknown),
        extend: jest.fn(async () => ({ state: state({ mode: 'controlling' }) }) as unknown),
        holdOf: jest.fn(async () => ({ held: false, untilMs: null })),
    };
    const signer = new TerminalAttachService();
    const controller = new ComputerController(
        agents as unknown as AgentsService,
        sessions as unknown as ComputerSessionService,
        {} as NodeAgentProfileService,
        new ComputerAttachService(signer),
        new ComputerRelayRegistry(),
        options.withControl === false ? undefined : (control as unknown as ComputerControlArbiter),
    );
    return { controller, agents, sessions, control, signer };
}

async function statusOf(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        const http = error as HttpException;
        return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> };
    }
    throw new Error('expected a refusal');
}

describe('ComputerController — taking control', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-control-spec-secret';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('404s every control route for another owner’s Agent before asking the arbiter anything', async () => {
        const { controller, agents, control } = build();
        agents.getOne.mockRejectedValue(new NotFoundException(`Agent ${AGENT} not found`));
        const calls = [
            controller.getControl(AUTH, AGENT, SESSION),
            controller.takeControl(AUTH, AGENT, SESSION, {}),
            controller.giveBackControl(AUTH, AGENT, SESSION),
            controller.answerControlRequest(AUTH, AGENT, SESSION, {
                requestId: OTHER_VIEW,
                decision: 'hand-over',
            }),
            controller.keepControl(AUTH, AGENT, SESSION),
            controller.extendControl(AUTH, AGENT, SESSION),
        ];
        for (const call of calls) await expect(call).rejects.toBeInstanceOf(NotFoundException);
        for (const method of Object.values(control)) expect(method).not.toHaveBeenCalled();
    });

    it('404s a view the arbiter does not find for this owner, exactly like an unknown one', async () => {
        const { controller, control } = build();
        control.getState.mockResolvedValue(null);
        control.take.mockResolvedValue(null);
        await expect(controller.getControl(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.takeControl(AUTH, AGENT, SESSION, {})).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('takes control, or asks for it with request: true, always scoped to the caller’s view', async () => {
        const { controller, control } = build();
        expect(await controller.takeControl(AUTH, AGENT, SESSION, {})).toMatchObject({
            mode: 'controlling',
        });
        expect(control.take).toHaveBeenCalledWith({
            userId: 'user-1',
            agentId: AGENT,
            sessionId: SESSION,
        });
        await controller.takeControl(AUTH, AGENT, SESSION, { request: true });
        expect(control.request).toHaveBeenCalledTimes(1);
    });

    it('answers a refusal by policy with 403, naming the policy', async () => {
        const { controller, control } = build();
        control.take.mockResolvedValue({ refused: 'policy', state: state({ canControl: false }) });
        const refused = await statusOf(controller.takeControl(AUTH, AGENT, SESSION, {}));
        expect(refused).toMatchObject({
            status: HttpStatus.FORBIDDEN,
            body: {
                reason: 'policy',
                policy: 'owner',
                message: 'Only the owner of this computer can take control.',
            },
        });
    });

    it('answers "someone else has control" with 409, naming the holder', async () => {
        const { controller, control } = build();
        control.take.mockResolvedValue({ refused: 'held', state: HELD_ELSEWHERE });
        const refused = await statusOf(controller.takeControl(AUTH, AGENT, SESSION, {}));
        expect(refused.status).toBe(HttpStatus.CONFLICT);
        expect(refused.body).toMatchObject({
            reason: 'held',
            holder: { sessionId: OTHER_VIEW, since: '2026-09-14T08:59:00.000Z' },
        });
    });

    it.each([
        'not-live',
        'session-ended',
        'not-holder',
        'not-held',
        'already-requested',
        'no-request',
        'already-extended',
    ] as const)('answers the %s refusal with 409 and its reason', async (reason) => {
        const outcome = { refused: reason, state: state() };
        expect(() => controlStateOrThrow(outcome, SESSION)).toThrow(ConflictException);
        try {
            controlStateOrThrow(outcome, SESSION);
        } catch (error) {
            const body = (error as HttpException).getResponse() as Record<string, unknown>;
            expect(body.reason).toBe(reason);
            expect(typeof body.message).toBe('string');
            expect(body.state).toEqual(state());
        }
    });

    it('gives control back with 204, hands over, keeps and extends through the arbiter', async () => {
        const { controller, control } = build();
        await expect(controller.giveBackControl(AUTH, AGENT, SESSION)).resolves.toBeUndefined();
        await controller.answerControlRequest(AUTH, AGENT, SESSION, {
            requestId: OTHER_VIEW,
            decision: 'keep',
        });
        expect(control.answer).toHaveBeenCalledWith(
            { userId: 'user-1', agentId: AGENT, sessionId: SESSION },
            OTHER_VIEW,
            'keep',
        );
        expect(await controller.keepControl(AUTH, AGENT, SESSION)).toMatchObject({
            mode: 'controlling',
        });
        control.extend.mockResolvedValue({ refused: 'already-extended', state: state() });
        await expect(controller.extendControl(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('answers 503 on every control route when the install has no arbiter', async () => {
        const { controller } = build({ withControl: false });
        const refused = await statusOf(controller.takeControl(AUTH, AGENT, SESSION, {}));
        expect(refused).toMatchObject({
            status: HttpStatus.SERVICE_UNAVAILABLE,
            body: { reason: 'control-unavailable' },
        });
        await expect(controller.getControl(AUTH, AGENT, SESSION)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });
});

describe('ComputerController — the driving token', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-control-spec-secret';
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('mints driver only for a controller request from the view that holds control', async () => {
        const { controller, control, signer } = build();
        control.holdOf.mockResolvedValue({ held: true, untilMs: Date.now() + 60_000 });

        const minted = await controller.mintAttachToken(AUTH, AGENT, SESSION, 'controller');
        expect(minted.role).toBe('driver');
        expect(new ComputerAttachService(signer).verify(minted.token)).toMatchObject({
            role: 'driver',
            sessionId: SESSION,
        });
        expect(control.holdOf).toHaveBeenCalledWith(SESSION);
    });

    it('downgrades a controller request to viewer when the view does not hold control', async () => {
        const { controller, control } = build();
        control.holdOf.mockResolvedValue({ held: false, untilMs: null });
        expect((await controller.mintAttachToken(AUTH, AGENT, SESSION, 'controller')).role).toBe(
            'viewer',
        );
    });

    it('never asks the arbiter for a plain watching token, and never mints driver without it', async () => {
        const { controller, control } = build();
        expect((await controller.mintAttachToken(AUTH, AGENT, SESSION)).role).toBe('viewer');
        expect(control.holdOf).not.toHaveBeenCalled();

        const bare = build({ withControl: false }).controller;
        expect((await bare.mintAttachToken(AUTH, AGENT, SESSION, 'controller')).role).toBe(
            'viewer',
        );
    });

    it('never mints driver for an ended view, even if a stale hold says so', async () => {
        const { controller, control, sessions } = build();
        control.holdOf.mockResolvedValue({ held: true, untilMs: null });
        sessions.getForOwner.mockResolvedValue({ id: SESSION, status: 'ended' });
        expect((await controller.mintAttachToken(AUTH, AGENT, SESSION, 'controller')).role).toBe(
            'viewer',
        );
    });
});

describe('ComputerController — control throttles', () => {
    it.each<[keyof ComputerController, number]>([
        ['takeControl', 20],
        ['answerControlRequest', 20],
        ['keepControl', 20],
        ['extendControl', 20],
    ])('%s is throttled at %d per minute', (method, limit) => {
        const handler = ComputerController.prototype[method];
        expect(Reflect.getMetadata(THROTTLER_LIMIT + 'long', handler)).toBe(limit);
        expect(Reflect.getMetadata(THROTTLER_TTL + 'long', handler)).toBe(60_000);
    });

    it('maps a policy refusal for a widened policy to a sentence naming that policy', () => {
        expect(() =>
            controlStateOrThrow(
                { refused: 'policy', state: state({ policy: 'org-admins', canControl: false }) },
                SESSION,
            ),
        ).toThrow(ForbiddenException);
    });
});
