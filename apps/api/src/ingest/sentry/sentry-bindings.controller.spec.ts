import { ConflictException, NotFoundException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    IngestInstallBindingRepository: class {},
}));
jest.mock('../../auth/decorators/user.decorator', () => ({
    CurrentUser: () => () => undefined,
}));

import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { SentryBindingsController } from './sentry-bindings.controller';
import { SentryInstallBindingService } from './sentry-install-binding.service';

const UUID = '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f';
const auth = { userId: 'user-a' } as AuthenticatedUser;

describe('SentryBindingsController (/api/ingest/sentry/bindings)', () => {
    let service: {
        listForUser: jest.Mock;
        claim: jest.Mock;
        unbind: jest.Mock;
    };
    let controller: SentryBindingsController;

    beforeEach(() => {
        service = {
            listForUser: jest.fn().mockResolvedValue([]),
            claim: jest.fn(),
            unbind: jest.fn(),
        };
        controller = new SentryBindingsController(
            service as unknown as SentryInstallBindingService,
        );
    });

    it('lists only the caller’s claims', async () => {
        const rows = [{ installationUuid: UUID, label: 'ever-co', createdAt: new Date() }];
        service.listForUser.mockResolvedValue(rows);
        await expect(controller.list(auth)).resolves.toEqual({ data: rows });
        expect(service.listForUser).toHaveBeenCalledWith('user-a');
    });

    it('claims for the SESSION user — the body carries the uuid, never the account', async () => {
        service.claim.mockResolvedValue({
            installationUuid: UUID,
            label: 'ever-co',
            createdAt: new Date(),
        });
        await controller.claim(auth, { installationUuid: UUID, label: 'ever-co' });
        expect(service.claim).toHaveBeenCalledWith('user-a', UUID, 'ever-co');
    });

    it('passes a missing label through as null', async () => {
        service.claim.mockResolvedValue({
            installationUuid: UUID,
            label: null,
            createdAt: new Date(),
        });
        await controller.claim(auth, { installationUuid: UUID });
        expect(service.claim).toHaveBeenCalledWith('user-a', UUID, null);
    });

    it('lets the service’s 409 through unchanged when somebody else holds the installation', async () => {
        service.claim.mockRejectedValue(new ConflictException('already claimed'));
        await expect(controller.claim(auth, { installationUuid: UUID })).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('releases the caller’s binding (204)', async () => {
        service.unbind.mockResolvedValue(true);
        await expect(controller.unbind(auth, UUID)).resolves.toBeUndefined();
        expect(service.unbind).toHaveBeenCalledWith('user-a', UUID);
    });

    it('answers 404 for a binding that is not the caller’s — existence never leaks', async () => {
        service.unbind.mockResolvedValue(false);
        await expect(controller.unbind(auth, UUID)).rejects.toBeInstanceOf(NotFoundException);
    });
});
