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
 */
describe('DefaultInboundEmailDispatcher', () => {
    let addresses: any;
    let assignments: any;
    let messages: any;
    let conversations: any;
    let taskSpawner: any;

    const basePayload = {
        pluginId: 'postmark',
        providerMessageId: 'pm-in-1',
        from: 'human@example.com',
        to: ['triage@acme.com'],
        subject: 'Need help with X',
        bodyText: 'please assist',
        receivedAt: new Date('2026-05-28T10:00:00Z'),
    };

    async function build(withSpawner: boolean) {
        addresses = { findByAddress: jest.fn() };
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
        addresses.findByAddress.mockResolvedValue(null);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no matching inbound address/);
    });

    it('returns handled:false when the address has no inbound assignment', async () => {
        const svc = await build(false);
        addresses.findByAddress.mockResolvedValue({ id: 'addr-1', userId: 'u1' });
        assignments.findByEmailAddress.mockResolvedValue([]);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no inbound agent assignment/);
    });

    it('task-spawn mode persists the message + delegates to the task spawner', async () => {
        const svc = await build(true);
        addresses.findByAddress.mockResolvedValue({ id: 'addr-1', userId: 'u1' });
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
        addresses.findByAddress.mockResolvedValue({ id: 'addr-1', userId: 'u1' });
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
        addresses.findByAddress.mockResolvedValue({ id: 'addr-1', userId: 'u1' });
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
        addresses.findByAddress.mockResolvedValue({ id: 'addr-1', userId: 'u1' });
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey.mockResolvedValue({ id: 'conv-existing' });
        const res = await svc.dispatch(basePayload);
        expect(res.conversationId).toBe('conv-existing');
        expect(conversations.save).not.toHaveBeenCalled();
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
