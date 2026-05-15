jest.mock('../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

jest.mock('@ever-works/agent/generators', () => ({
    CodeUpdateGeneratorService: class {},
}));

jest.mock('@ever-works/agent/database', () => ({
    UserRepository: class {},
    WorkRepository: class {},
}));

jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));

jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class {},
}));

jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { GENERATION: 'generation' },
    ActivityStatus: { COMPLETED: 'completed', IN_PROGRESS: 'in_progress' },
    WorkCodeUpdateSource: { MANUAL: 'manual' },
}));

import { BadRequestException } from '@nestjs/common';
import { CodeUpdateController } from './code-update.controller';
import type { CodeUpdateGeneratorService } from '@ever-works/agent/generators';
import type { UserRepository, WorkRepository } from '@ever-works/agent/database';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('CodeUpdateController', () => {
    let codeUpdateService: {
        request: jest.Mock;
        execute: jest.Mock;
        list: jest.Mock;
        get: jest.Mock;
        apply: jest.Mock;
        reject: jest.Mock;
    };
    let ownershipService: { ensureCanView: jest.Mock; ensureCanEdit: jest.Mock };
    let activityLogService: { log: jest.Mock };
    let controller: CodeUpdateController;

    const auth: AuthenticatedUser = { userId: 'user-1' } as AuthenticatedUser;

    beforeEach(() => {
        codeUpdateService = {
            request: jest.fn(),
            execute: jest.fn(),
            list: jest.fn(),
            get: jest.fn(),
            apply: jest.fn(),
            reject: jest.fn(),
        };
        ownershipService = {
            ensureCanView: jest.fn().mockResolvedValue(undefined),
            ensureCanEdit: jest.fn().mockResolvedValue(undefined),
        };
        activityLogService = { log: jest.fn().mockResolvedValue(undefined) };

        controller = new CodeUpdateController(
            codeUpdateService as unknown as CodeUpdateGeneratorService,
            ownershipService as unknown as WorkOwnershipService,
            {} as UserRepository,
            {} as WorkRepository,
            activityLogService as unknown as ActivityLogService,
        );
    });

    it('does not apply a code update that belongs to a different work', async () => {
        codeUpdateService.get.mockResolvedValue({
            id: 'code-update-1',
            workId: 'other-work',
        });

        await expect(controller.apply(auth, 'work-1', 'code-update-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );

        expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
        expect(codeUpdateService.apply).not.toHaveBeenCalled();
        expect(activityLogService.log).not.toHaveBeenCalled();
    });

    it('does not reject a code update that belongs to a different work', async () => {
        codeUpdateService.get.mockResolvedValue({
            id: 'code-update-1',
            workId: 'other-work',
        });

        await expect(controller.reject(auth, 'work-1', 'code-update-1')).rejects.toBeInstanceOf(
            BadRequestException,
        );

        expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
        expect(codeUpdateService.reject).not.toHaveBeenCalled();
        expect(activityLogService.log).not.toHaveBeenCalled();
    });
});
