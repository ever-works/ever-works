import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { ActiveScopeService } from '../services/active-scope.service';
import { UserScopeController } from './user-scope.controller';

describe('UserScopeController', () => {
    const auth = { userId: 'user-1' } as AuthenticatedUser;
    let activeScope: jest.Mocked<Pick<ActiveScopeService, 'getActiveScope' | 'updateActiveScope'>>;
    let controller: UserScopeController;
    let moduleRef: TestingModule;

    beforeEach(async () => {
        activeScope = {
            getActiveScope: jest.fn(),
            updateActiveScope: jest.fn(),
        };
        moduleRef = await Test.createTestingModule({
            controllers: [UserScopeController],
            providers: [{ provide: ActiveScopeService, useValue: activeScope }],
        }).compile();
        controller = moduleRef.get(UserScopeController);
    });

    afterEach(async () => {
        await moduleRef.close();
    });

    it('returns the authenticated user persisted active scope', async () => {
        activeScope.getActiveScope.mockResolvedValue({
            tenantId: 'tenant-1',
            organizationId: 'org-ever',
            organizationSlug: 'ever',
        });

        await expect(controller.get(auth)).resolves.toMatchObject({ organizationSlug: 'ever' });
        expect(activeScope.getActiveScope).toHaveBeenCalledWith('user-1');
    });

    it('persists the requested Organization before returning it', async () => {
        activeScope.updateActiveScope.mockResolvedValue({
            tenantId: 'tenant-1',
            organizationId: 'org-ever',
            organizationSlug: 'ever',
        });

        await expect(controller.update(auth, { organizationSlug: 'ever' })).resolves.toMatchObject({
            organizationId: 'org-ever',
        });
        expect(activeScope.updateActiveScope).toHaveBeenCalledWith('user-1', 'ever');
    });
});
