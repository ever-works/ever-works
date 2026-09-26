import { Test } from '@nestjs/testing';
import { DefaultInboundEmailDispatcher } from './default-inbound-email-dispatcher.service';
import { deriveThreadKey, INBOUND_EMAIL_TASK_SPAWNER } from './agent-inbound-email-dispatcher';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '@src/database';

/**
 * EW-670 / T25 — inbound dispatcher coverage: address resolution,
 * task-spawn vs conversation branching, and the deriveThreadKey helper.
 *
 * PLG-1 follow-up — the destination is the address the webhook was
 * AUTHENTICATED for (`payload.recipient`, from `EmailFacadeService.parseInbound`),
 * never one re-derived from the attacker-controlled `to` list. The cases below
 * used to stub `findByAddress` for `to[0]` (that re-derivation was the bypass);
 * they now name the authenticated address and stub `findById` for it. What
 * each case asserts about branching is unchanged.
 */
describe('DefaultInboundEmailDispatcher', () => {
    let addresses: any;
    let assignments: any;
    let messages: any;
    let conversations: any;
    let taskSpawner: any;

    // The authenticated address: inbound, on the webhook's plugin, owned by u1.
    const inboundAddress = {
        id: 'addr-1',
        userId: 'u1',
        pluginId: 'postmark',
        direction: 'inbound',
        disabledAt: null,
    };

    const basePayload = {
        pluginId: 'postmark',
        recipient: { emailAddressId: 'addr-1', userId: 'u1' } as {
            emailAddressId: string;
            userId: string;
        } | null,
        providerMessageId: 'pm-in-1',
        from: 'human@example.com',
        to: ['triage@acme.com'],
        subject: 'Need help with X',
        bodyText: 'please assist',
        receivedAt: new Date('2026-05-28T10:00:00Z'),
    };

    async function build(withSpawner: boolean) {
        addresses = { findByAddress: jest.fn(), findById: jest.fn() };
        assignments = { findByEmailAddress: jest.fn() };
        messages = {
            save: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            updateDeliveryStatus: jest.fn().mockResolvedValue(undefined),
        };
        conversations = {
            findByThreadKey: jest.fn(),
            save: jest.fn().mockResolvedValue({ id: 'conv-1' }),
            touchLastMessageAt: jest.fn().mockResolvedValue(undefined),
        };
        taskSpawner = {
            spawnTaskForInboundEmail: jest.fn().mockResolvedValue({ taskId: 'task-1' }),
        };

        const providers: any[] = [
            DefaultInboundEmailDispatcher,
            { provide: TenantEmailAddressRepository, useValue: addresses },
            { provide: AgentEmailAssignmentRepository, useValue: assignments },
            { provide: EmailMessageRepository, useValue: messages },
            { provide: EmailConversationRepository, useValue: conversations },
        ];
        if (withSpawner) {
            providers.push({ provide: INBOUND_EMAIL_TASK_SPAWNER, useValue: taskSpawner });
        }
        const moduleRef = await Test.createTestingModule({ providers }).compile();
        return moduleRef.get(DefaultInboundEmailDispatcher);
    }

    it('returns handled:false when no inbound address matches', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(null);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no matching inbound address/);
    });

    it('returns handled:false when the address has no inbound assignment', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([]);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no inbound agent assignment/);
    });

    it('task-spawn mode persists the message + delegates to the task spawner', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch(basePayload);
        expect(res).toMatchObject({
            handled: true,
            agentId: 'agent-1',
            mode: 'task-spawn',
            emailMessageId: 'msg-1',
            taskId: 'task-1',
        });
        expect(messages.save).toHaveBeenCalledTimes(1);
        expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'agent-1', emailMessageId: 'msg-1' }),
        );
    });

    it('task-spawn mode without a spawner persists but does not create a task', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(true);
        expect(res.taskId).toBeUndefined();
        expect(messages.save).toHaveBeenCalledTimes(1);
    });

    it('conversation mode creates a thread + links the message', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey.mockResolvedValue(null);
        const res = await svc.dispatch(basePayload);
        expect(res).toMatchObject({
            handled: true,
            mode: 'conversation',
            conversationId: 'conv-1',
            emailMessageId: 'msg-1',
        });
        expect(conversations.save).toHaveBeenCalledTimes(1);
        expect(conversations.touchLastMessageAt).toHaveBeenCalledWith(
            'conv-1',
            basePayload.receivedAt,
        );
        expect(taskSpawner?.spawnTaskForInboundEmail).not.toHaveBeenCalled();
    });

    it('conversation mode reuses an existing thread', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey.mockResolvedValue({ id: 'conv-existing' });
        const res = await svc.dispatch(basePayload);
        expect(res.conversationId).toBe('conv-existing');
        expect(conversations.save).not.toHaveBeenCalled();
    });

    describe('routes only to the authenticated address (PLG-1 follow-up)', () => {
        it("never re-derives the destination from the payload's `to` list", async () => {
            const svc = await build(true);
            // Another tenant's registered mailbox is listed first.
            addresses.findByAddress.mockResolvedValue({
                id: 'addr-victim',
                userId: 'victim',
                pluginId: 'postmark',
                direction: 'inbound',
                disabledAt: null,
            });
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockImplementation(async (id: string) => [
                { agentId: `agent-of-${id}`, dispatchMode: 'task-spawn' },
            ]);

            const res = await svc.dispatch({
                ...basePayload,
                to: ['victim@example.com', 'triage@acme.com'],
            });

            expect(addresses.findByAddress).not.toHaveBeenCalled();
            expect(addresses.findById).toHaveBeenCalledWith('addr-1');
            expect(res).toMatchObject({ handled: true, agentId: 'agent-of-addr-1' });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ emailAddressId: 'addr-1', userId: 'u1' }),
            );
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
                expect.objectContaining({ agentId: 'agent-of-addr-1', userId: 'u1' }),
            );
        });

        it.each([
            ['no authenticated address', null],
            ['an authenticated address without an id', { emailAddressId: '', userId: 'u1' }],
        ])('dispatches nothing for %s', async (_case, recipient) => {
            const svc = await build(true);
            addresses.findByAddress.mockResolvedValue(inboundAddress);

            const res = await svc.dispatch({ ...basePayload, recipient });

            expect(res).toMatchObject({ handled: false, reason: 'no matching inbound address' });
            expect(addresses.findByAddress).not.toHaveBeenCalled();
            expect(messages.save).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
        });

        it.each([
            ['belongs to another owner', { userId: 'someone-else' }],
            ['is registered with another provider', { pluginId: 'mailgun' }],
            ['is disabled', { disabledAt: new Date('2026-09-01T00:00:00Z') }],
            ['is outbound-only', { direction: 'outbound' }],
        ])('refuses an authenticated address that %s', async (_case, patch) => {
            const svc = await build(true);
            addresses.findById.mockResolvedValue({ ...inboundAddress, ...patch });
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);

            const res = await svc.dispatch(basePayload);

            expect(res).toMatchObject({ handled: false, reason: 'no matching inbound address' });
            expect(messages.save).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
        });

        it('accepts an authenticated address that handles both directions', async () => {
            const svc = await build(true);
            addresses.findById.mockResolvedValue({ ...inboundAddress, direction: 'both' });
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);

            await expect(svc.dispatch(basePayload)).resolves.toMatchObject({
                handled: true,
                agentId: 'agent-1',
            });
        });
    });
});

describe('deriveThreadKey', () => {
    it('strips Re:/Fwd: prefixes and normalizes', () => {
        expect(deriveThreadKey('Re: Re: Hello World')).toBe('hello world');
        expect(deriveThreadKey('FWD:  Spaced   Out ')).toBe('spaced out');
    });
    it('falls back for an empty subject', () => {
        expect(deriveThreadKey('   ')).toBe('(no subject)');
    });
});
