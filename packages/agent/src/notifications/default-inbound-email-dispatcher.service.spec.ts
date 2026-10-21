import { Test } from '@nestjs/testing';
import {
    boundAttachmentRecords,
    boundInboundMetadata,
    DefaultInboundEmailDispatcher,
    MAX_INBOUND_ATTACHMENT_LIST_BYTES,
    MAX_INBOUND_ATTACHMENTS,
    MAX_INBOUND_METADATA_BYTES,
    MAX_LISTED_INBOUND_ATTACHMENTS,
} from './default-inbound-email-dispatcher.service';
import {
    deriveThreadKey,
    INBOUND_EMAIL_ATTACHMENT_STORE,
    INBOUND_EMAIL_TASK_SPAWNER,
} from './agent-inbound-email-dispatcher';
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
    let attachmentStore: any;

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

    async function build(withSpawner: boolean, withStore = false) {
        addresses = { findByAddress: jest.fn(), findById: jest.fn() };
        assignments = { findByEmailAddress: jest.fn() };
        messages = {
            save: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            updateDeliveryStatus: jest.fn().mockResolvedValue(undefined),
            findByMessageIdHeaders: jest.fn().mockResolvedValue([]),
            linkTask: jest.fn().mockResolvedValue(true),
            findByProviderMessageId: jest.fn().mockResolvedValue(null),
        };
        conversations = {
            findById: jest.fn().mockResolvedValue(null),
            findByThreadKey: jest.fn(),
            save: jest.fn().mockResolvedValue({ id: 'conv-1' }),
            touchLastMessageAt: jest.fn().mockResolvedValue(undefined),
        };
        taskSpawner = {
            spawnTaskForInboundEmail: jest.fn().mockResolvedValue({ taskId: 'task-1' }),
        };
        let uploads = 0;
        attachmentStore = {
            store: jest.fn(async () => {
                uploads += 1;
                return { uploadId: `sha-${uploads}`, url: `/api/uploads/sha-${uploads}` };
            }),
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
        if (withStore) {
            providers.push({ provide: INBOUND_EMAIL_ATTACHMENT_STORE, useValue: attachmentStore });
        }
        const moduleRef = await Test.createTestingModule({ providers }).compile();
        return moduleRef.get(DefaultInboundEmailDispatcher);
    }

    // Review 2026-10-17 U2 (F113): a provider retry of a message already delivered is
    // acknowledged before anything is stored again (no second upload, no unique-row 500).
    it('acknowledges a provider retry of a delivered message without storing anything again', async () => {
        const svc = await build(true, true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        messages.findByProviderMessageId.mockResolvedValue({
            id: 'msg-first',
            agentId: 'agent-1',
            taskId: 'task-first',
            conversationId: null,
        });
        const result = await svc.dispatch({
            ...basePayload,
            attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', content: 'JVBERi0x' }],
        } as never);
        expect(result).toMatchObject({
            handled: true,
            emailMessageId: 'msg-first',
            taskId: 'task-first',
            reason: 'duplicate',
        });
        expect(attachmentStore.store).not.toHaveBeenCalled();
        expect(messages.save).not.toHaveBeenCalled();
        expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
    });

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

    describe('the trusted-sender rule (reviews of #2769)', () => {
        afterEach(() => {
            delete process.env.INBOUND_EMAIL_TRUSTED_SENDERS;
        });

        const RECEIVING = 'support@agents.acme.test';
        const alignedPass = { dkim: 'pass', dkimDomain: 'acme.test' };

        async function spawnFrom(
            from: string,
            setup?: (svc: any) => void,
            extra: Record<string, unknown> = {},
        ) {
            const svc = await build(true);
            addresses.findById.mockResolvedValue({ ...inboundAddress, address: RECEIVING });
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);
            setup?.(svc);
            await svc.dispatch({ ...basePayload, from, ...extra });
            return taskSpawner.spawnTaskForInboundEmail.mock.calls.at(-1)[0];
        }

        const ownerUser = (svc: any, emailVerified = true) => {
            svc.users = {
                findById: jest.fn(async () => ({ email: 'owner@acme.test', emailVerified })),
            };
        };

        it('marks an unknown sender untrusted', async () => {
            expect((await spawnFrom('stranger@evil.test')).senderTrusted).toBe(false);
        });

        it("trusts the owner's verified account email only with an aligned authentication pass", async () => {
            const withPass = await spawnFrom('Owner <OWNER@acme.test>', ownerUser, {
                metadata: alignedPass,
            });
            expect(withPass.senderTrusted).toBe(true);
            // No provider verdict: the From spelling alone is not enough for an owner address.
            expect((await spawnFrom('owner@acme.test', ownerUser)).senderTrusted).toBe(false);
        });

        it('does not trust an UNVERIFIED account email', async () => {
            const input = await spawnFrom('owner@acme.test', (svc) => ownerUser(svc, false), {
                metadata: alignedPass,
            });
            expect(input.senderTrusted).toBe(false);
        });

        it('SELF-ADDRESS SPOOF: From = the receiving address (or an inbound-only one) is never trusted', async () => {
            const ownedAddresses = () => {
                addresses.findAllByUser = jest.fn(async () => [
                    {
                        id: 'addr-1',
                        address: RECEIVING,
                        verified: true,
                        disabledAt: null,
                        direction: 'both',
                    },
                    {
                        id: 'addr-in',
                        address: 'inbox@agents.acme.test',
                        verified: true,
                        disabledAt: null,
                        direction: 'inbound',
                    },
                    {
                        id: 'addr-out',
                        address: 'ops@agents.acme.test',
                        verified: true,
                        disabledAt: null,
                        direction: 'outbound',
                    },
                ]);
            };
            const agentsPass = { metadata: { dkim: 'pass', dkimDomain: 'agents.acme.test' } };

            expect((await spawnFrom(RECEIVING, ownedAddresses, agentsPass)).senderTrusted).toBe(
                false,
            );
            expect(
                (await spawnFrom('inbox@agents.acme.test', ownedAddresses, agentsPass))
                    .senderTrusted,
            ).toBe(false);
            // Control: a verified OUTBOUND address of the owner, with an aligned pass, is trusted.
            expect(
                (await spawnFrom('ops@agents.acme.test', ownedAddresses, agentsPass)).senderTrusted,
            ).toBe(true);
        });

        it('trusts agent-to-agent mail recognised from the platform outbound record, not From', async () => {
            const OTHER = 'ops@agents.acme.test';
            const sentRow = (svc: any) => {
                void svc;
                messages.findByMessageIdHeaders.mockImplementation(async () => [
                    {
                        id: 'sent-1',
                        direction: 'outbound',
                        sentAt: new Date(),
                        from: OTHER,
                        toAddresses: [RECEIVING],
                        messageIdHeader: 'm-1@agents.acme.test',
                    },
                ]);
            };
            const sent = await spawnFrom(OTHER, sentRow, {
                messageIdHeader: 'm-1@agents.acme.test',
            });
            expect(sent.senderTrusted).toBe(true);

            // CodeRabbit on #2769: a REPLAY — the address already received this
            // platform Message-ID (an earlier inbound row, not this delivery's
            // own `msg-1`) — earns no trust.
            const sentAnd = (inbound: Record<string, unknown>) => (svc: any) => {
                void svc;
                messages.findByMessageIdHeaders.mockImplementation(async () => [
                    {
                        id: 'sent-1',
                        direction: 'outbound',
                        sentAt: new Date(),
                        from: OTHER,
                        toAddresses: [RECEIVING],
                        messageIdHeader: 'm-1@agents.acme.test',
                    },
                    {
                        direction: 'inbound',
                        emailAddressId: 'addr-1',
                        from: OTHER,
                        messageIdHeader: 'm-1@agents.acme.test',
                        ...inbound,
                    },
                ]);
            };
            const replay = await spawnFrom(OTHER, sentAnd({ id: 'in-earlier' }), {
                messageIdHeader: 'm-1@agents.acme.test',
            });
            expect(replay.senderTrusted).toBe(false);

            // This delivery's OWN stored row is not a replay of itself.
            const own = await spawnFrom(OTHER, sentAnd({ id: 'msg-1' }), {
                messageIdHeader: 'm-1@agents.acme.test',
            });
            expect(own.senderTrusted).toBe(true);

            // A copy another of the owner's addresses received is not a replay here.
            const elsewhere = await spawnFrom(
                OTHER,
                sentAnd({ id: 'in-other', emailAddressId: 'addr-2' }),
                { messageIdHeader: 'm-1@agents.acme.test' },
            );
            expect(elsewhere.senderTrusted).toBe(true);

            // Same Message-ID, a different From: not the message the platform sent.
            const forged = await spawnFrom('mallory@evil.test', sentRow, {
                messageIdHeader: 'm-1@agents.acme.test',
            });
            expect(forged.senderTrusted).toBe(false);
        });

        it('trusts a configured sender by spelling only when the provider reports no verdict', async () => {
            process.env.INBOUND_EMAIL_TRUSTED_SENDERS = '@partner.test';
            expect((await spawnFrom('ops@partner.test')).senderTrusted).toBe(true);
            const failed = await spawnFrom('ops@partner.test', undefined, {
                metadata: { spf: 'fail' },
            });
            expect(failed.senderTrusted).toBe(false);
            const unaligned = await spawnFrom('ops@partner.test', undefined, {
                metadata: { spf: 'pass', spfDomain: 'bulk-mailer.test' },
            });
            expect(unaligned.senderTrusted).toBe(false);
        });
    });

    // Review 2026-10-17 F15 (P1): an address can serve several agents; a push the
    // caller authorized for ONE agent goes to that agent, never assignments[0].
    it('routes to the agent the caller named, not the first assignment of the address', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'personal-agent', dispatchMode: 'conversation' },
            { agentId: 'org-agent', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch({ ...basePayload, agentId: 'org-agent' });
        expect(res).toMatchObject({ handled: true, agentId: 'org-agent', mode: 'task-spawn' });
        expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'org-agent' }),
        );
    });

    it('refuses when the named agent has no inbound assignment on the address', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'personal-agent', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch({ ...basePayload, agentId: 'org-agent' });
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no inbound assignment/);
        expect(messages.save).not.toHaveBeenCalled();
        expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
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
        conversations.findByThreadKey.mockResolvedValue({
            id: 'conv-existing',
            participants: [{ address: 'Human <HUMAN@example.com>' }],
        });
        const res = await svc.dispatch(basePayload);
        expect(res.conversationId).toBe('conv-existing');
        expect(conversations.save).not.toHaveBeenCalled();
        // The participant matched on the plain subject key — one lookup.
        expect(conversations.findByThreadKey).toHaveBeenCalledTimes(1);
    });

    it('conversation mode never mixes a DIFFERENT sender into a subject-matched thread', async () => {
        // Prompt-injection hardening: a subject is not an identity.
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey
            .mockResolvedValueOnce({
                id: 'conv-someone-else',
                participants: [{ address: 'victim@client.test' }],
            })
            .mockResolvedValueOnce(null);

        const res = await svc.dispatch(basePayload);

        expect(res.conversationId).not.toBe('conv-someone-else');
        const [, scopedKey] = conversations.findByThreadKey.mock.calls[1];
        expect(scopedKey).toMatch(/^need help with x #[0-9a-f]{16}$/);
        expect(conversations.save).toHaveBeenCalledWith(
            expect.objectContaining({
                threadKey: scopedKey,
                participants: [{ address: 'human@example.com' }],
            }),
        );
    });

    // EW-P4-3 — the spawned Task is written back onto the message.
    it('task-spawn mode links the message to the Task it spawned', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        await svc.dispatch(basePayload);
        expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-1');
    });

    it('a failing back-link never fails the dispatch', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        messages.linkTask.mockRejectedValue(new Error('db down'));
        await expect(svc.dispatch(basePayload)).resolves.toMatchObject({
            handled: true,
            taskId: 'task-1',
        });
    });

    describe('RFC threading (EW-P4-3)', () => {
        const reply = {
            ...basePayload,
            providerMessageId: 'pm-in-2',
            subject: 'A completely different subject',
            messageIdHeader: 'reply-2@client.test',
            inReplyTo: 'out-1@acme.test',
            references: ['root@client.test', 'out-1@acme.test'],
        };

        async function taskSpawnAgent(withAppend: boolean) {
            const svc = await build(true);
            if (withAppend) {
                taskSpawner.appendInboundEmailToTask = jest
                    .fn()
                    .mockImplementation(async ({ taskId }: { taskId: string }) => ({ taskId }));
            }
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);
            return svc;
        }

        it('persists the threading ids on the inbound row', async () => {
            const svc = await taskSpawnAgent(false);
            await svc.dispatch(reply);
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    messageIdHeader: 'reply-2@client.test',
                    inReplyTo: 'out-1@acme.test',
                    references: ['root@client.test', 'out-1@acme.test'],
                }),
            );
        });

        it('looks up In-Reply-To first, then References newest-first, owner-scoped, never its own id', async () => {
            const svc = await taskSpawnAgent(true);
            await svc.dispatch({
                ...reply,
                references: ['root@client.test', 'reply-2@client.test', 'out-1@acme.test'],
            });
            expect(messages.findByMessageIdHeaders).toHaveBeenCalledWith('u1', [
                'out-1@acme.test',
                'root@client.test',
            ]);
        });

        it('task-spawn: a reply to a message linked to a Task joins that Task', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'msg-out-1',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({
                handled: true,
                mode: 'task-spawn',
                taskId: 'task-original',
                threaded: true,
            });
            expect(taskSpawner.appendInboundEmailToTask).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-original',
                    agentId: 'agent-1',
                    userId: 'u1',
                    emailMessageId: 'msg-1',
                }),
            );
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
            expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-original');
        });

        it('task-spawn: a sender who is NOT a participant of the thread never joins it', async () => {
            // Prompt-injection hardening: In-Reply-To is the sender's to write.
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'msg-out-1',
                    agentId: 'agent-1',
                    toAddresses: ['customer@client.test'],
                    ccAddresses: ['cc@client.test'],
                    from: 'agent@acme.test',
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);

            const res = await svc.dispatch({ ...reply, from: 'Mallory <mallory@evil.test>' });

            expect(res).toMatchObject({ handled: true, taskId: 'task-1' });
            expect(res.threaded).toBeUndefined();
            expect(taskSpawner.appendInboundEmailToTask).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        // CodeRabbit on #2769: participation is judged on the thread the reply
        // would JOIN, not on the union of every message its headers name.
        it('task-spawn: a participant of ANOTHER referenced thread cannot join the selected one', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    // In-Reply-To target (selected first): the victim's thread.
                    id: 'm-victim',
                    agentId: 'agent-1',
                    from: 'agent@acme.test',
                    toAddresses: ['victim@client.test'],
                    taskId: 'task-victim',
                    messageIdHeader: 'out-1@acme.test',
                },
                {
                    // Also referenced: a thread Mallory really is part of.
                    id: 'm-mallory',
                    agentId: 'agent-1',
                    from: 'agent@acme.test',
                    toAddresses: ['mallory@evil.test'],
                    taskId: 'task-mallory',
                    messageIdHeader: 'root@client.test',
                },
            ]);

            const res = await svc.dispatch({ ...reply, from: 'mallory@evil.test' });

            expect(res.threaded).toBeUndefined();
            expect(taskSpawner.appendInboundEmailToTask).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        it('task-spawn: a cc participant may join (case and display name do not matter)', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'msg-out-1',
                    agentId: 'agent-1',
                    toAddresses: ['customer@client.test'],
                    ccAddresses: ['Human@Example.com'],
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            await expect(svc.dispatch(reply)).resolves.toMatchObject({
                taskId: 'task-original',
                threaded: true,
            });
        });

        it('task-spawn: prefers the In-Reply-To match over an older References match', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-root',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    taskId: 'task-root',
                    messageIdHeader: 'root@client.test',
                },
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    taskId: 'task-out',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            await expect(svc.dispatch(reply)).resolves.toMatchObject({ taskId: 'task-out' });
        });

        it("task-spawn: never joins another Agent's thread", async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-x',
                    agentId: 'agent-2',
                    taskId: 'task-of-agent-2',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            const res = await svc.dispatch(reply);
            expect(res).toMatchObject({ taskId: 'task-1' });
            expect(res.threaded).toBeUndefined();
            expect(taskSpawner.appendInboundEmailToTask).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        it('task-spawn: falls back to a new Task when appending fails (the reply is never lost)', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            taskSpawner.appendInboundEmailToTask.mockRejectedValue(new Error('secret detected'));

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({ handled: true, taskId: 'task-1' });
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
            expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-1');
            expect(messages.linkTask).not.toHaveBeenCalledWith('msg-1', 'task-original');
        });

        it('task-spawn: a spawner without appendInboundEmailToTask keeps one Task per message', async () => {
            const svc = await taskSpawnAgent(false);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            await expect(svc.dispatch(reply)).resolves.toMatchObject({ taskId: 'task-1' });
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        it('a failing thread lookup falls back instead of failing the dispatch', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockRejectedValue(new Error('db down'));
            await expect(svc.dispatch(reply)).resolves.toMatchObject({
                handled: true,
                taskId: 'task-1',
            });
        });

        it("conversation: a reply joins the parent's conversation whatever its subject", async () => {
            const svc = await build(false);
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'conversation' },
            ]);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    conversationId: 'conv-thread',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            conversations.findById.mockResolvedValue({ id: 'conv-thread', agentId: 'agent-1' });

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({ conversationId: 'conv-thread', threaded: true });
            expect(conversations.findByThreadKey).not.toHaveBeenCalled();
            expect(conversations.save).not.toHaveBeenCalled();
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ conversationId: 'conv-thread' }),
            );
        });

        it('conversation: ignores a conversation that belongs to another Agent and falls back to the subject', async () => {
            const svc = await build(false);
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'conversation' },
            ]);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    toAddresses: ['Human <human@example.com>'],
                    conversationId: 'conv-foreign',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            conversations.findById.mockResolvedValue({ id: 'conv-foreign', agentId: 'agent-2' });
            conversations.findByThreadKey.mockResolvedValue({ id: 'conv-by-subject' });

            const res = await svc.dispatch(reply);

            expect(res.conversationId).toBe('conv-by-subject');
            expect(res.threaded).toBeUndefined();
        });

        it('a message with no threading headers does no lookup', async () => {
            const svc = await taskSpawnAgent(true);
            await svc.dispatch(basePayload);
            expect(messages.findByMessageIdHeaders).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });
    });

    // EW-P4-3 — inbound data: attachments, cc, metadata, tenant / org stamp.
    describe('inbound data (EW-P4-3)', () => {
        const orgAddress = { ...inboundAddress, tenantId: 'tenant-1', organizationId: 'org-1' };
        const b64 = (text: string) => Buffer.from(text).toString('base64');

        async function agentOn(mode: 'task-spawn' | 'conversation', withStore = true) {
            const svc = await build(true, withStore);
            addresses.findById.mockResolvedValue(orgAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: mode },
            ]);
            conversations.findByThreadKey.mockResolvedValue(null);
            return svc;
        }

        it("stamps the row with the receiving address's tenant and organization", async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch(basePayload);
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'org-1' }),
            );
        });

        it('stamps explicit NULLs for a personal address (never the empty request scope)', async () => {
            const svc = await build(true);
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);
            await svc.dispatch(basePayload);
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: null, organizationId: null }),
            );
        });

        it('stamps a new conversation too', async () => {
            const svc = await agentOn('conversation');
            await svc.dispatch(basePayload);
            expect(conversations.save).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', organizationId: 'org-1' }),
            );
        });

        it('hands the scope and the attachment list to the task spawner', async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch({
                ...basePayload,
                attachments: [
                    { filename: 'a.pdf', mimeType: 'application/pdf', content: b64('%PDF-1') },
                ],
            });
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
                expect.objectContaining({
                    tenantId: 'tenant-1',
                    organizationId: 'org-1',
                    attachments: [
                        {
                            filename: 'a.pdf',
                            mimeType: 'application/pdf',
                            size: 6,
                            stored: true,
                            uploadId: 'sha-1',
                        },
                    ],
                }),
            );
        });

        it('keeps cc and the provider metadata', async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch({
                ...basePayload,
                cc: ['c1@b.test', 'c2@b.test'],
                metadata: { spamScore: 1.2, fromName: 'Ada' },
            });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    ccAddresses: ['c1@b.test', 'c2@b.test'],
                    metadata: { spamScore: 1.2, fromName: 'Ada' },
                }),
            );
        });

        it("stores attachments for the address owner, in the address's scope, and lists them", async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch({
                ...basePayload,
                attachments: [
                    {
                        filename: 'a.pdf',
                        mimeType: 'Application/PDF',
                        content: b64('%PDF-1'),
                        cid: 'c1',
                    },
                    { filename: 'b.png', mimeType: 'image/png', content: b64('png!') },
                ],
            });
            expect(attachmentStore.store).toHaveBeenCalledWith({
                userId: 'u1',
                tenantId: 'tenant-1',
                organizationId: 'org-1',
                filename: 'a.pdf',
                mimeType: 'application/pdf',
                content: Buffer.from('%PDF-1'),
            });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [
                        {
                            filename: 'a.pdf',
                            mimeType: 'application/pdf',
                            size: 6,
                            cid: 'c1',
                            stored: true,
                            uploadId: 'sha-1',
                            url: '/api/uploads/sha-1',
                        },
                        {
                            filename: 'b.png',
                            mimeType: 'image/png',
                            size: 4,
                            cid: null,
                            stored: true,
                            uploadId: 'sha-2',
                            url: '/api/uploads/sha-2',
                        },
                    ],
                }),
            );
        });

        it('lists a refused attachment with the reason and still delivers the message', async () => {
            const svc = await agentOn('task-spawn');
            attachmentStore.store.mockRejectedValueOnce(
                Object.assign(new Error('Bad Request'), {
                    response: {
                        code: 'MimeMismatch',
                        message: 'File has no recognized magic-byte signature',
                    },
                }),
            );
            const res = await svc.dispatch({
                ...basePayload,
                attachments: [
                    { filename: 'evil.exe', mimeType: 'application/pdf', content: b64('MZ') },
                ],
            });
            expect(res).toMatchObject({ handled: true, taskId: 'task-1' });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [
                        expect.objectContaining({
                            filename: 'evil.exe',
                            stored: false,
                            uploadId: null,
                            reason: 'MimeMismatch: File has no recognized magic-byte signature',
                        }),
                    ],
                }),
            );
        });

        it('lists attachments as not stored when no store is bound', async () => {
            const svc = await agentOn('task-spawn', false);
            await svc.dispatch({
                ...basePayload,
                attachments: [
                    { filename: 'a.pdf', mimeType: 'application/pdf', content: b64('%PDF-1') },
                ],
            });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [
                        expect.objectContaining({
                            stored: false,
                            reason: 'no attachment store bound',
                        }),
                    ],
                }),
            );
        });

        it('stores at most the per-message count and lists the rest', async () => {
            const svc = await agentOn('task-spawn');
            const many = Array.from({ length: MAX_INBOUND_ATTACHMENTS + 2 }, (_, i) => ({
                filename: `f${i}.pdf`,
                mimeType: 'application/pdf',
                content: b64('%PDF-1'),
            }));
            await svc.dispatch({ ...basePayload, attachments: many });
            expect(attachmentStore.store).toHaveBeenCalledTimes(MAX_INBOUND_ATTACHMENTS);
            const saved = messages.save.mock.calls[0][0].attachments;
            expect(saved).toHaveLength(MAX_INBOUND_ATTACHMENTS + 2);
            expect(saved[MAX_INBOUND_ATTACHMENTS].stored).toBe(false);
        });

        it('sanitizes a sender-written filename and skips empty content', async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch({
                ...basePayload,
                attachments: [
                    {
                        filename: 'a\u0000b\r\n.pdf',
                        mimeType: 'application/pdf',
                        content: b64('%PDF-1'),
                    },
                    { filename: '', mimeType: '', content: '' },
                ],
            });
            const saved = messages.save.mock.calls[0][0].attachments;
            expect(saved[0].filename).toBe('ab.pdf');
            expect(saved[1]).toMatchObject({
                filename: 'attachment',
                mimeType: 'application/octet-stream',
                stored: false,
                reason: 'empty',
            });
            expect(attachmentStore.store).toHaveBeenCalledTimes(1);
        });

        it('writes NULL attachments for a message without any', async () => {
            const svc = await agentOn('task-spawn');
            await svc.dispatch(basePayload);
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ attachments: null, ccAddresses: null, metadata: null }),
            );
            expect(attachmentStore.store).not.toHaveBeenCalled();
        });
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

    it.each<[string, string]>([
        ['re:fwd:FW: x', 'x'],
        ['  Re :  Fwd:\tRe:\nHello', 'hello'],
        ['Re: Re', 're'],
        ['Re Hello', 're hello'],
        ['Fwd:', '(no subject)'],
        ['Refund: Re: x', 'refund: re: x'],
        ['fw: fwd: fwx: y', 'fwx: y'],
    ])('keys %p as %p', (subject, key) => {
        expect(deriveThreadKey(subject)).toBe(key);
    });

    // The subject is sender-controlled (any inbound email). CodeQL flagged the
    // prefix pattern as polynomial on whitespace runs; these are the shapes it
    // names. V8 answers them in linear time with the old pattern too (well
    // under 10 ms at 20,000 characters, measured 2026-10-09), so this pins
    // linearity against a later rewrite that really does backtrack — e.g. a
    // regex trim, `/\s+$/` over an interior whitespace run, needs ~40 s at this
    // size on a dev box. Sized rather than tightly timed: a "< 200 ms" at
    // 50,000 was one scheduler stall on a CPU-throttled CI runner from red
    // (develop CI, 2026-10-09); 2 s at 200,000 is neither.
    it.each<[string, string]>([
        ['whitespace before a non-prefix', `${' '.repeat(200_000)}x`],
        ['a prefix, then whitespace, then a partial prefix', `re:${' '.repeat(200_000)}r`],
        ['many prefixes', 're: '.repeat(200_000)],
        ['a prefix word and whitespace with no colon', `re${' '.repeat(200_000)}x`],
    ])('keys a subject of %s in linear time', (_, subject) => {
        const started = performance.now();
        deriveThreadKey(subject);
        const elapsedMs = performance.now() - started;

        expect(elapsedMs).toBeLessThan(2_000);
    });
});

describe('boundInboundMetadata (EW-P4-3)', () => {
    it('keeps small metadata as given', () => {
        expect(boundInboundMetadata({ spamScore: 2 })).toEqual({ spamScore: 2 });
        expect(boundInboundMetadata(undefined)).toBeNull();
    });

    it('drops the raw header list first when too large', () => {
        const headers = Array.from({ length: 2000 }, (_, i) => ({
            Name: `X-${i}`,
            Value: 'v'.repeat(20),
        }));
        expect(boundInboundMetadata({ spamScore: 2, headers })).toEqual({
            spamScore: 2,
            headersOmitted: true,
        });
    });

    it('keeps only the keys when still too large', () => {
        const bounded = boundInboundMetadata({ blob: 'x'.repeat(MAX_INBOUND_METADATA_BYTES + 1) });
        expect(bounded).toEqual({ truncated: true, keys: ['blob'] });
    });

    // Review on #2612: `simple-json` is a MySQL TEXT (65,535 BYTES), so the
    // bound is on UTF-8 bytes — multibyte text counts for what it weighs.
    it('bounds by UTF-8 bytes, not characters', () => {
        const chars = Math.floor(MAX_INBOUND_METADATA_BYTES / 2);
        const bounded = boundInboundMetadata({ note: '€'.repeat(chars) });
        expect(bounded).toEqual({ truncated: true, keys: ['note'] });
    });

    it('never throws on a value that cannot be serialized', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(boundInboundMetadata(cyclic)).toEqual({ truncated: true, keys: ['self'] });
    });
});

/** Review on #2612 — the attachment list must fit a MySQL TEXT column. */
describe('boundAttachmentRecords (EW-P4-3)', () => {
    const record = (i: number, stored = false) => ({
        filename: `${'f'.repeat(240)}-${i}.bin`,
        mimeType: 'application/octet-stream',
        size: 10,
        cid: `${'c'.repeat(240)}-${i}`,
        stored,
        uploadId: stored ? `sha-${i}` : null,
        reason: stored ? undefined : 'over the 20-attachment limit',
    });

    it('keeps a short list as it is', () => {
        const list = [record(1, true), record(2)];
        expect(boundAttachmentRecords(list)).toEqual(list);
    });

    it('lists at most the cap and sums the rest in one record', () => {
        const list = Array.from({ length: 120 }, (_, i) => record(i, i < 3));
        const bounded = boundAttachmentRecords(list);
        const last = bounded[bounded.length - 1];
        expect(bounded.length).toBeLessThanOrEqual(MAX_LISTED_INBOUND_ATTACHMENTS + 1);
        expect(last.filename).toMatch(/^\d+ more attachments$/);
        const listed = bounded.length - 1;
        expect(Number(last.filename.split(' ')[0])).toBe(120 - listed);
        expect(last.size).toBe((120 - listed) * 10);
        expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
            MAX_INBOUND_ATTACHMENT_LIST_BYTES,
        );
    });

    it('stays within the byte budget with multibyte names', () => {
        const list = Array.from({ length: 50 }, (_, i) => ({
            ...record(i),
            filename: '名'.repeat(255),
        }));
        const bounded = boundAttachmentRecords(list);
        expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
            MAX_INBOUND_ATTACHMENT_LIST_BYTES,
        );
        expect(bounded[bounded.length - 1].filename).toMatch(/more attachments?$/);
    });
});
