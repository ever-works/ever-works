import {
    BadRequestException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

// Same barrel mocks as the service spec: the real barrels pull ESM-only
// modules that stop the suite from loading at all.
jest.mock('@ever-works/agent/services', () => ({ PlatformSyncSecretService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class {},
    StripeRelayDeadLetterRepository: class {},
    UserRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    StripeRelayDeadLetterResolution: {
        STRIPE_RETRY: 'stripe-retry',
        REPLAYED: 'replayed',
        DISMISSED: 'dismissed',
    },
    StripeRelayDeadLetterStatus: { OPEN: 'open', RESOLVED: 'resolved' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({ constructStripeEvent: jest.fn() }));
jest.mock('@ever-works/agent/utils', () => ({ isSafeWebhookUrl: jest.fn(() => true) }));
jest.mock('@src/auth/guards/platform-admin.guard', () => ({ IsPlatformAdminGuard: class {} }));
// The REAL metadata decorators (not no-ops), so the access-control specs at the
// bottom can read which routes are public and which guards apply.
jest.mock('@src/auth/decorators/public.decorator', () => ({
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Public: () => require('@nestjs/common').SetMetadata('isPublic', true),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StripeRelayController } = require('../stripe-relay.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StripeRelayAdminController } = require('../stripe-relay-admin.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StripeRelayDeadLetterNotFoundError } = require('../stripe-relay.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IsPlatformAdminGuard } = require('@src/auth/guards/platform-admin.guard');

function relayService(overrides: Record<string, unknown> = {}) {
    return {
        isEnabled: jest.fn().mockReturnValue(true),
        openDeadLetterCount: jest.fn().mockResolvedValue(0),
        replay: jest.fn(),
        dismiss: jest.fn(),
        ...overrides,
    };
}

describe('StripeRelayController health (alert hook)', () => {
    it('is 404 while the relay is switched off, like the relay route itself', async () => {
        const controller = new StripeRelayController(
            relayService({ isEnabled: jest.fn().mockReturnValue(false) }),
        );
        await expect(controller.health()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is 200 {ok:true} with no dead letter past the grace period', async () => {
        const controller = new StripeRelayController(relayService());
        await expect(controller.health()).resolves.toEqual({ ok: true });
    });

    it('is 503 {ok:false} while one is open, and says nothing else', async () => {
        const controller = new StripeRelayController(
            relayService({ openDeadLetterCount: jest.fn().mockResolvedValue(3) }),
        );
        const error = await controller.health().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        // No count, no event id, no Work id on a public route.
        expect((error as ServiceUnavailableException).getResponse()).toEqual({ ok: false });
    });
});

describe('StripeRelayAdminController', () => {
    function build(service = relayService()) {
        const deadLetters = { list: jest.fn().mockResolvedValue([[], 0]) };
        return {
            controller: new StripeRelayAdminController(service, deadLetters),
            deadLetters,
            service,
        };
    }

    it('lists with sane paging defaults and an optional status filter', async () => {
        const { controller, deadLetters } = build();
        await expect(controller.list()).resolves.toEqual({
            items: [],
            total: 0,
            limit: 25,
            offset: 0,
        });
        expect(deadLetters.list).toHaveBeenCalledWith({ status: undefined, limit: 25, offset: 0 });

        await controller.list('open', '500', '10');
        expect(deadLetters.list).toHaveBeenLastCalledWith({
            status: 'open',
            limit: 100,
            offset: 10,
        });

        await controller.list('all');
        expect(deadLetters.list).toHaveBeenLastCalledWith({
            status: undefined,
            limit: 25,
            offset: 0,
        });
    });

    it('rejects an unknown status and non-integer paging', async () => {
        const { controller } = build();
        await expect(controller.list('pending')).rejects.toBeInstanceOf(BadRequestException);
        await expect(controller.list(undefined, 'ten')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('only accepts Stripe event ids', async () => {
        const { controller, service } = build();
        for (const bad of ['1; drop table', 'cs_live_123', 'evt_', 'evt_../x']) {
            await expect(controller.replay(bad)).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.dismiss(bad)).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(service.replay).not.toHaveBeenCalled();
        expect(service.dismiss).not.toHaveBeenCalled();
    });

    it('maps a missing dead letter to 404', async () => {
        const { controller } = build(
            relayService({
                replay: jest
                    .fn()
                    .mockRejectedValue(new StripeRelayDeadLetterNotFoundError('evt_1')),
                dismiss: jest
                    .fn()
                    .mockRejectedValue(new StripeRelayDeadLetterNotFoundError('evt_1')),
            }),
        );
        await expect(controller.replay('evt_1')).rejects.toBeInstanceOf(NotFoundException);
        await expect(controller.dismiss('evt_1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the replay verdict and the dismiss result', async () => {
        const { controller } = build(
            relayService({
                replay: jest.fn().mockResolvedValue({
                    status: 'forwarded',
                    eventId: 'evt_1',
                    workId: 'w',
                    siteStatus: 200,
                }),
                dismiss: jest.fn().mockResolvedValue(true),
            }),
        );
        await expect(controller.replay('evt_1')).resolves.toMatchObject({ status: 'forwarded' });
        await expect(controller.dismiss('evt_1')).resolves.toEqual({
            eventId: 'evt_1',
            dismissed: true,
        });
    });
});

describe('Stripe relay access control', () => {
    // A dropped decorator would leave every behavioural spec above green while
    // opening replay/dismiss of payment events to any signed-in user, so pin
    // the metadata itself.
    const publicRoutes = (controller: { prototype: object }) =>
        Object.getOwnPropertyNames(controller.prototype).filter(
            (name) =>
                name !== 'constructor' &&
                Reflect.getMetadata(
                    'isPublic',
                    (controller.prototype as Record<string, unknown>)[name] as object,
                ) === true,
        );

    it('puts every admin dead-letter route behind IsPlatformAdminGuard', () => {
        expect(Reflect.getMetadata(GUARDS_METADATA, StripeRelayAdminController)).toEqual([
            IsPlatformAdminGuard,
        ]);
    });

    it('makes no admin dead-letter route public', () => {
        expect(Reflect.getMetadata('isPublic', StripeRelayAdminController)).toBeUndefined();
        expect(publicRoutes(StripeRelayAdminController)).toEqual([]);
    });

    it('keeps exactly the Stripe receiver and the health probe public on the relay controller', () => {
        // Control: the helper does see public metadata when it is there.
        expect(publicRoutes(StripeRelayController).sort()).toEqual(['health', 'receive']);
    });
});
