import { EMAIL_SEND_RESERVATION_PENDING_PLUGIN_ID, EmailFacadeService } from '../email.facade';
import { EmailApprovalRequiredException } from '../../email/email-approval-required.exception';
import { EmailSendCapExceededException } from '../../email/email-send-cap-exceeded.exception';
import type { EmailSendPolicyGate } from '../../email/email-send-policy.port';

/**
 * Agent email (AW-05) — `EmailFacadeService.send` is the one place every
 * outbound path converges, so the approve-before-send gate and the send
 * ceilings are asked there, BEFORE any provider is resolved. These tests
 * prove the ordering (a refused send never reaches a plugin or its
 * credentials) and that a released draft moves its existing row instead of
 * writing a second one.
 */
function makeFacade(gate?: EmailSendPolicyGate) {
    const plugin = {
        id: 'postmark',
        name: 'Postmark',
        version: '1.0.0',
        category: 'email',
        capabilities: ['email-outbound'],
        sendEmail: jest.fn().mockResolvedValue({
            provider: 'postmark',
            providerMessageId: 'pm-1',
            accepted: ['ada@example.com'],
            rejected: [],
        }),
        verifyAddress: jest.fn(),
    };
    const registry = {
        getByCapability: jest.fn().mockReturnValue([{ plugin, state: 'loaded' }]),
        get: jest.fn().mockReturnValue({ plugin, state: 'loaded' }),
    };
    const settings = {
        getResolvedSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
    };
    const emailMessages = {
        save: jest.fn().mockResolvedValue({}),
        transitionStatus: jest.fn().mockResolvedValue(1),
    };
    const facade = new EmailFacadeService(
        registry as never,
        settings as never,
        undefined,
        undefined,
        undefined,
        emailMessages as never,
        undefined,
        gate,
    );
    const resolveSpy = jest
        .spyOn(
            facade as unknown as { resolveOutboundPlugin: () => unknown },
            'resolveOutboundPlugin',
        )
        .mockResolvedValue(plugin as never);
    return { facade, plugin, emailMessages, resolveSpy };
}

const INPUT = {
    from: 'nova@agents.example.com',
    to: ['ada@example.com'],
    cc: ['grace@example.com'],
    subject: 'Quarterly numbers',
    bodyText: 'Attached.',
    messageRef: 'ref-1',
};

describe('EmailFacadeService.send — send policy gate (AW-05)', () => {
    it('asks the gate with the attribution, recipients and subject before resolving a provider', async () => {
        const calls: string[] = [];
        const gate = {
            assertSendAllowed: jest.fn(async () => {
                calls.push('gate');
            }),
        };
        const { facade, resolveSpy, plugin } = makeFacade(gate);
        resolveSpy.mockImplementation((async () => {
            calls.push('resolve');
            return plugin;
        }) as never);

        await facade.send(INPUT, {
            userId: 'user-1',
            agentId: 'agent-1',
            addressId: 'addr-1',
            origin: 'agent',
        });

        expect(calls).toEqual(['gate', 'resolve']);
        expect(gate.assertSendAllowed).toHaveBeenCalledWith({
            userId: 'user-1',
            agentId: 'agent-1',
            origin: 'agent',
            draftMessageId: undefined,
            to: ['ada@example.com'],
            cc: ['grace@example.com'],
            bcc: undefined,
            subject: 'Quarterly numbers',
        });
    });

    it.each([
        ['held for approval', new EmailApprovalRequiredException('awaiting-approval', 'agent-1')],
        [
            'over a ceiling',
            new EmailSendCapExceededException({
                scope: 'inbox',
                limitKind: 'inboxBurst',
                used: 10,
                cap: 10,
                windowSeconds: 60,
                retryAfterSeconds: 12,
            }),
        ],
    ])('never touches a provider when the send is %s', async (_label, refusal) => {
        const gate = { assertSendAllowed: jest.fn().mockRejectedValue(refusal) };
        const { facade, resolveSpy, plugin, emailMessages } = makeFacade(gate);

        await expect(
            facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' }),
        ).rejects.toBe(refusal);

        expect(resolveSpy).not.toHaveBeenCalled();
        expect(plugin.sendEmail).not.toHaveBeenCalled();
        expect(emailMessages.save).not.toHaveBeenCalled();
    });

    it('records a direct send as a sent row', async () => {
        const { facade, emailMessages } = makeFacade({
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
        });
        await facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' });
        expect(emailMessages.save).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'sent',
                direction: 'outbound',
                providerMessageId: 'pm-1',
            }),
        );
        expect(emailMessages.transitionStatus).not.toHaveBeenCalled();
    });

    it('moves a released draft to sent instead of inserting a duplicate row', async () => {
        const { facade, emailMessages } = makeFacade({
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
        });
        await facade.send(INPUT, {
            userId: 'user-1',
            agentId: 'agent-1',
            addressId: 'addr-1',
            origin: 'agent',
            draftMessageId: 'draft-1',
        });
        expect(emailMessages.save).not.toHaveBeenCalled();
        expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
            'draft-1',
            ['sending'],
            'sent',
            expect.objectContaining({ providerMessageId: 'pm-1', deliveryStatus: 'accepted' }),
        );
    });

    describe('admitSend — reserved capacity is settled exactly once', () => {
        const gateWith = (reservedMessageId: string | null) => ({
            assertSendAllowed: jest.fn(),
            admitSend: jest.fn().mockResolvedValue({ reservedMessageId }),
        });

        it('prefers admitSend and offers the row to reserve, before resolving a provider', async () => {
            const calls: string[] = [];
            const gate = gateWith(null);
            gate.admitSend.mockImplementation(async () => {
                calls.push('admit');
                return { reservedMessageId: null };
            });
            const { facade, resolveSpy, plugin } = makeFacade(gate);
            resolveSpy.mockImplementation((async () => {
                calls.push('resolve');
                return plugin;
            }) as never);

            await facade.send(INPUT, {
                userId: 'user-1',
                agentId: 'agent-1',
                addressId: 'addr-1',
                taskId: 'task-1',
                origin: 'agent',
            });

            expect(calls).toEqual(['admit', 'resolve']);
            expect(gate.assertSendAllowed).not.toHaveBeenCalled();
            expect(gate.admitSend).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', agentId: 'agent-1', origin: 'agent' }),
                {
                    kind: 'message',
                    row: {
                        userId: 'user-1',
                        agentId: 'agent-1',
                        taskId: 'task-1',
                        emailAddressId: 'addr-1',
                        pluginId: EMAIL_SEND_RESERVATION_PENDING_PLUGIN_ID,
                        from: 'nova@agents.example.com',
                        toAddresses: ['ada@example.com'],
                        ccAddresses: ['grace@example.com'],
                        bccAddresses: null,
                        subject: 'Quarterly numbers',
                        bodyText: 'Attached.',
                        bodyHtml: null,
                        metadata: null,
                        messageRef: 'ref-1',
                    },
                },
            );
        });

        it('records the send after the provider accepts it when nothing was reserved (as before)', async () => {
            const { facade, emailMessages } = makeFacade(gateWith(null));
            await facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' });
            expect(emailMessages.save).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'sent', providerMessageId: 'pm-1' }),
            );
            expect(emailMessages.transitionStatus).not.toHaveBeenCalled();
        });

        it('moves the reservation to sent instead of inserting a second row', async () => {
            const { facade, emailMessages } = makeFacade(gateWith('res-1'));
            await facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' });
            expect(emailMessages.save).not.toHaveBeenCalled();
            expect(emailMessages.transitionStatus).toHaveBeenCalledTimes(1);
            expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
                'res-1',
                ['sending'],
                'sent',
                expect.objectContaining({
                    pluginId: 'postmark',
                    providerMessageId: 'pm-1',
                    deliveryStatus: 'accepted',
                    sentAt: expect.any(Date),
                }),
            );
        });

        it('releases the reservation (failed, no sentAt) when the provider refuses, and rethrows', async () => {
            const { facade, emailMessages, plugin } = makeFacade(gateWith('res-1'));
            const providerError = new Error('provider 503');
            plugin.sendEmail.mockRejectedValue(providerError);

            await expect(
                facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' }),
            ).rejects.toBe(providerError);

            expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
                'res-1',
                ['sending'],
                'failed',
                { sentAt: null, failureReason: 'provider 503', pluginId: 'postmark' },
            );
            expect(emailMessages.save).not.toHaveBeenCalled();
        });

        it('releases the reservation when no provider can be resolved', async () => {
            const { facade, emailMessages, resolveSpy } = makeFacade(gateWith('res-1'));
            resolveSpy.mockRejectedValue(new Error('no provider') as never);
            await expect(
                facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' }),
            ).rejects.toThrow('no provider');
            expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
                'res-1',
                ['sending'],
                'failed',
                { sentAt: null, failureReason: 'no provider' },
            );
        });

        it("clears a released draft's stamp on failure and leaves its outcome to the draft loop", async () => {
            const gate = gateWith('draft-1');
            const { facade, emailMessages, plugin } = makeFacade(gate);
            plugin.sendEmail.mockRejectedValue(new Error('provider 503'));
            await expect(
                facade.send(INPUT, {
                    userId: 'user-1',
                    agentId: 'agent-1',
                    addressId: 'addr-1',
                    origin: 'agent',
                    draftMessageId: 'draft-1',
                }),
            ).rejects.toThrow('provider 503');
            expect(gate.admitSend).toHaveBeenCalledWith(expect.anything(), { kind: 'draft' });
            expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
                'draft-1',
                ['sending'],
                'sending',
                { sentAt: null },
            );
        });

        it('offers no reservation when the send would not be recorded (no address)', async () => {
            const gate = gateWith(null);
            const { facade } = makeFacade(gate);
            await facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1' });
            expect(gate.admitSend).toHaveBeenCalledWith(expect.anything(), null);
        });

        it('never touches a provider or a row when admission refuses', async () => {
            const refusal = new EmailSendCapExceededException({
                scope: 'inbox',
                limitKind: 'inboxDaily',
                used: 2,
                cap: 2,
                windowSeconds: 86_400,
                retryAfterSeconds: 60,
            });
            const gate = {
                assertSendAllowed: jest.fn(),
                admitSend: jest.fn().mockRejectedValue(refusal),
            };
            const { facade, resolveSpy, plugin, emailMessages } = makeFacade(gate);
            await expect(
                facade.send(INPUT, { userId: 'user-1', agentId: 'agent-1', addressId: 'addr-1' }),
            ).rejects.toBe(refusal);
            expect(resolveSpy).not.toHaveBeenCalled();
            expect(plugin.sendEmail).not.toHaveBeenCalled();
            expect(emailMessages.save).not.toHaveBeenCalled();
            expect(emailMessages.transitionStatus).not.toHaveBeenCalled();
        });
    });

    it('keeps sending without a gate in a bare construction (pre-gate behaviour)', async () => {
        const { facade, plugin } = makeFacade(undefined);
        await expect(
            facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' }),
        ).resolves.toMatchObject({ providerMessageId: 'pm-1' });
        expect(plugin.sendEmail).toHaveBeenCalledTimes(1);
    });
});
