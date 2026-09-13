import { EmailFacadeService } from '../email.facade';
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

    it('keeps sending without a gate in a bare construction (pre-gate behaviour)', async () => {
        const { facade, plugin } = makeFacade(undefined);
        await expect(
            facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' }),
        ).resolves.toMatchObject({ providerMessageId: 'pm-1' });
        expect(plugin.sendEmail).toHaveBeenCalledTimes(1);
    });
});
