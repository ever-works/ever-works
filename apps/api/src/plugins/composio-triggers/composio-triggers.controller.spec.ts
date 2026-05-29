import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';

// The controller is constructed directly with mocks below; stub the
// heavy import-graph modules so loading the controller doesn't pull the
// real auth → agent/database chain (which uses the agent-internal
// `@src/config` alias the api jest config can't resolve) or the Composio
// SDK. Mirrors the mocking strategy in composio.service.spec.ts.
jest.mock('../composio/composio.service', () => ({ ComposioService: class {} }));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));
jest.mock('@src/auth/decorators/public.decorator', () => ({ Public: () => () => undefined }));

import { ComposioTriggersController } from './composio-triggers.controller';
import type { ComposioTriggersService } from './composio-triggers.service';
import type { ComposioService } from '../composio/composio.service';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';

const auth = { userId: 'user-1' } as AuthenticatedUser;

describe('ComposioTriggersController', () => {
    let triggers: jest.Mocked<
        Pick<
            ComposioTriggersService,
            'create' | 'remove' | 'findByComposioTriggerId' | 'recordDelivery'
        >
    >;
    let composio: jest.Mocked<
        Pick<ComposioService, 'createTrigger' | 'deleteTrigger' | 'verifyWebhook'>
    >;
    let controller: ComposioTriggersController;

    beforeEach(() => {
        triggers = {
            create: jest.fn(),
            remove: jest.fn(),
            findByComposioTriggerId: jest.fn(),
            recordDelivery: jest.fn().mockResolvedValue(undefined),
        } as never;
        composio = {
            createTrigger: jest.fn(),
            deleteTrigger: jest.fn().mockResolvedValue(true),
            verifyWebhook: jest.fn(),
        } as never;
        controller = new ComposioTriggersController(
            triggers as unknown as ComposioTriggersService,
            composio as unknown as ComposioService,
        );
    });

    describe('create', () => {
        it('enables the trigger upstream then persists the row keyed by the real tg_* id', async () => {
            composio.createTrigger.mockResolvedValue({ triggerId: 'tg_real_1' });
            triggers.create.mockResolvedValue({
                id: 'sub-1',
                toolkitSlug: 'GMAIL',
                triggerSlug: 'GMAIL_NEW_EMAIL',
                composioTriggerId: 'tg_real_1',
                composioConnectedAccountId: 'ca_1',
                enabled: true,
                deliveriesReceived: 0,
                deliveriesRejected: 0,
                lastFiredAt: null,
                createdAt: new Date('2026-05-29T00:00:00Z'),
            } as never);

            const dto = await controller.create(auth, {
                toolkitSlug: 'GMAIL',
                triggerSlug: 'GMAIL_NEW_EMAIL',
                composioConnectedAccountId: 'ca_1',
            } as never);

            expect(composio.createTrigger).toHaveBeenCalledWith('user-1', {
                triggerSlug: 'GMAIL_NEW_EMAIL',
                connectedAccountId: 'ca_1',
                config: undefined,
            });
            expect(triggers.create).toHaveBeenCalledWith('user-1', 'tg_real_1', expect.any(Object));
            expect(dto.composioTriggerId).toBe('tg_real_1');
            // The vestigial per-subscription secret is never surfaced.
            expect((dto as unknown as Record<string, unknown>).webhookSecret).toBeUndefined();
        });
    });

    describe('remove', () => {
        it('removes locally then tears the trigger down upstream', async () => {
            triggers.remove.mockResolvedValue('tg_real_1');
            await controller.remove(auth, 'sub-1');
            expect(triggers.remove).toHaveBeenCalledWith('user-1', 'sub-1');
            expect(composio.deleteTrigger).toHaveBeenCalledWith('user-1', 'tg_real_1');
        });
    });

    describe('webhook', () => {
        const v3Body = { type: 'gmail.new_email', metadata: { trigger_id: 'tg_real_1' } };
        const headers = {
            'webhook-id': 'wh_1',
            'webhook-signature': 'v1,sig',
            'webhook-timestamp': '1700000000',
        };

        it('400s when the trigger id is missing from the payload', async () => {
            await expect(
                controller.webhook({ rawBody: '{}' }, {} as never, headers),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('404s for an unknown trigger', async () => {
            triggers.findByComposioTriggerId.mockResolvedValue(null);
            await expect(
                controller.webhook({ rawBody: JSON.stringify(v3Body) }, v3Body as never, headers),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('verifies via the owning user, records accepted, and returns ok', async () => {
            triggers.findByComposioTriggerId.mockResolvedValue({
                id: 'sub-1',
                userId: 'owner-7',
            } as never);
            composio.verifyWebhook.mockResolvedValue({ version: 'V3', payload: {} });

            const result = await controller.webhook(
                { rawBody: JSON.stringify(v3Body) },
                v3Body as never,
                headers,
            );

            expect(triggers.findByComposioTriggerId).toHaveBeenCalledWith('tg_real_1');
            expect(composio.verifyWebhook).toHaveBeenCalledWith('owner-7', {
                id: 'wh_1',
                rawBody: JSON.stringify(v3Body),
                signature: 'v1,sig',
                timestamp: '1700000000',
            });
            expect(triggers.recordDelivery).toHaveBeenCalledWith('sub-1', 'accepted');
            expect(result).toEqual({ ok: true });
        });

        it('records rejected and rethrows when verification fails', async () => {
            triggers.findByComposioTriggerId.mockResolvedValue({
                id: 'sub-1',
                userId: 'owner-7',
            } as never);
            composio.verifyWebhook.mockRejectedValue(new UnauthorizedException('bad sig'));

            await expect(
                controller.webhook({ rawBody: JSON.stringify(v3Body) }, v3Body as never, headers),
            ).rejects.toBeInstanceOf(UnauthorizedException);
            expect(triggers.recordDelivery).toHaveBeenCalledWith('sub-1', 'rejected');
        });
    });
});
