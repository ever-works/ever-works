jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('@ever-works/agent/cache', () => ({
    DistributedTaskLockService: class DistributedTaskLockService {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    User: class User {},
}));
jest.mock('@ever-works/agent/user-research', () => ({
    UserResearchModule: class UserResearchModule {},
    UserResearchService: class UserResearchService {},
    WorkProposalService: class WorkProposalService {},
    UserResearchLimitsService: class UserResearchLimitsService {},
    UserResearchRateLimitedError: class UserResearchRateLimitedError extends Error {},
    WorkProposalSource: {
        AUTO_SIGNUP: 'auto-signup',
        USER_REFRESH: 'user-refresh',
        SCHEDULED: 'scheduled',
        USER_MANUAL: 'user-manual',
        MISSION: 'mission',
    },
    WorkProposalStatus: {
        PENDING: 'pending',
        DISMISSED: 'dismissed',
        ACCEPTED: 'accepted',
        QUEUED: 'queued',
        BUILDING: 'building',
        FAILED: 'failed',
    },
}));
// Phase 1 PR B — WorkProposalsApiService now imports WorkAgentService
// from @ever-works/agent/work-agent; matching the other deep-import
// stubs in this file.
jest.mock('@ever-works/agent/work-agent', () => ({
    WorkAgentService: class WorkAgentService {},
    WorkAgentModule: class WorkAgentModule {},
}));
// Phase 7 PR U — module now imports BudgetsModule so the
// controller can wire GET /:id/budget to BudgetService.
jest.mock('@ever-works/agent/budgets', () => ({
    BudgetService: class BudgetService {},
    BudgetsModule: class BudgetsModule {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { trigger: { shouldUseTrigger: jest.fn(() => false) } },
}));
jest.mock('../auth/auth.module', () => ({
    AuthModule: class AuthModule {},
}));
jest.mock('../auth/decorators/user.decorator', () => ({
    CurrentUser: () => () => undefined,
}));
jest.mock('../events', () => ({
    UserConfirmedEvent: class UserConfirmedEvent {
        static EVENT_NAME = 'user.confirmed';
    },
}));

import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '@ever-works/agent/database';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { UserResearchModule } from '@ever-works/agent/user-research';
import { AuthModule } from '../auth/auth.module';
import { ScheduledReRunService } from './scheduled-rerun.service';
import { UserResearchListener } from './user-research.listener';
import { WorkCreatedLearningListener } from './work-created.listener';
import { WorkProposalsApiService } from './work-proposals.service';
import { WorkProposalsModule } from './work-proposals.module';

describe('WorkProposalsModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, WorkProposalsModule) ?? [];
    const importName = (entry: any) => entry?.name ?? entry?.module?.name;

    it('imports the modules required by its direct provider dependencies', () => {
        const names = meta('imports').map(importName);

        expect(names).toEqual(
            expect.arrayContaining([
                UserResearchModule.name,
                DatabaseModule.name,
                AuthModule.name,
                ConfigModule.name,
                TypeOrmModule.name,
            ]),
        );
    });

    it('declares the work-proposals API providers', () => {
        expect(meta('providers')).toEqual(
            expect.arrayContaining([
                WorkProposalsApiService,
                UserResearchListener,
                WorkCreatedLearningListener,
                ScheduledReRunService,
                DistributedTaskLockService,
            ]),
        );
    });
});
