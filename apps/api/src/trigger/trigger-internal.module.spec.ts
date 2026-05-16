jest.mock('@ever-works/agent/work-operations', () => ({
    WorkOperationsModule: class WorkOperationsModule {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkModule: class WorkModule {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('@ever-works/agent/facades', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
}));
jest.mock('../work-proposals/work-proposals.module', () => ({
    WorkProposalsModule: class WorkProposalsModule {},
}));
jest.mock('../data-sync/data-sync.module', () => ({
    DataSyncModule: class DataSyncModule {},
}));
jest.mock('./trigger-internal.controller', () => ({
    TriggerInternalController: class TriggerInternalController {},
}));

import { FacadesModule } from '@ever-works/agent/facades';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { WorkModule } from '@ever-works/agent/services';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { TriggerInternalController } from './trigger-internal.controller';
import { TriggerInternalModule } from './trigger-internal.module';

describe('TriggerInternalModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, TriggerInternalModule) ?? [];

    it('imports the modules required by remote targets exposed by TriggerInternalController', () => {
        expect(meta('imports')).toEqual(
            expect.arrayContaining([
                WorkOperationsModule,
                WorkModule,
                NotificationsModule,
                FacadesModule,
                WorkProposalsModule,
            ]),
        );
    });

    it('declares the internal trigger controller', () => {
        expect(meta('controllers')).toContain(TriggerInternalController);
    });
});
