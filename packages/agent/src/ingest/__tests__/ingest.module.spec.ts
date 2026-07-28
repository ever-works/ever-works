/**
 * Event-ingest spine (Wave 6, pull path Wave 8) — module-shape pin for
 * EventIngestModule.
 *
 * Pattern mirrors `knowledge-base.module.spec.ts`: heavy runtime trees
 * (TypeORM, the facades/activity-log graphs) are mocked at module scope
 * so the decorator metadata can be asserted without loading them under
 * Jest's CJS transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../../entities/ingested-event.entity', () => ({
    IngestedEvent: class IngestedEvent {},
}));
jest.mock('../../entities/ingest-cursor.entity', () => ({
    IngestCursor: class IngestCursor {},
}));
jest.mock('../../entities/ingest-install-binding.entity', () => ({
    IngestInstallBinding: class IngestInstallBinding {},
}));
jest.mock('../../activity-log/activity-log.module', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../ingested-event.repository', () => ({
    IngestedEventRepository: class IngestedEventRepository {},
}));
jest.mock('../event-ingest.service', () => ({
    EventIngestService: class EventIngestService {},
}));
jest.mock('../ingest-cursor.repository', () => ({
    IngestCursorRepository: class IngestCursorRepository {},
}));
jest.mock('../event-source-pull.service', () => ({
    EventSourcePullService: class EventSourcePullService {},
}));
jest.mock('../ingest-install-binding.repository', () => ({
    IngestInstallBindingRepository: class IngestInstallBindingRepository {},
}));
jest.mock('../../entities/external-issue-link.entity', () => ({
    ExternalIssueLink: class ExternalIssueLink {},
}));
jest.mock('../ingest-salience.service', () => ({
    IngestSalienceService: class IngestSalienceService {},
}));
jest.mock('../external-issue-link.repository', () => ({
    ExternalIssueLinkRepository: class ExternalIssueLinkRepository {},
}));
jest.mock('../external-issue-link.service', () => ({
    ExternalIssueLinkService: class ExternalIssueLinkService {},
}));

import 'reflect-metadata';
import { WorkRepository } from '../../database/repositories/work.repository';
import { TaskRepository } from '../../database/repositories/task.repository';
import { WorkHintResolverService } from '../work-hint-resolver.service';
import { EventIngestModule } from '../ingest.module';
import { IngestedEventRepository } from '../ingested-event.repository';
import { EventIngestService } from '../event-ingest.service';
import { IngestCursorRepository } from '../ingest-cursor.repository';
import { EventSourcePullService } from '../event-source-pull.service';
import { IngestInstallBindingRepository } from '../ingest-install-binding.repository';
import { IngestSalienceService } from '../ingest-salience.service';
import { ExternalIssueLinkRepository } from '../external-issue-link.repository';
import { ExternalIssueLinkService } from '../external-issue-link.service';
import { ActivityLogModule } from '../../activity-log/activity-log.module';
import { FacadesModule } from '../../facades/facades.module';

const EXPECTED_PROVIDERS = [
    IngestedEventRepository,
    EventIngestService,
    IngestCursorRepository,
    EventSourcePullService,
    WorkRepository,
    WorkHintResolverService,
    IngestInstallBindingRepository,
    // Salience filter (audit item (k)) + external-issue ↔ Task mapping
    // (audit item (i)). `TaskRepository` backs the ownership check the
    // link service runs before every write.
    IngestSalienceService,
    ExternalIssueLinkRepository,
    ExternalIssueLinkService,
    TaskRepository,
];

describe('EventIngestModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, EventIngestModule) ?? [];

    it('provides the repositories, the ingest service and the pull service', () => {
        expect(meta('providers')).toEqual(EXPECTED_PROVIDERS);
    });

    it('exports every provider for the API surface + trigger-internal RPC wiring', () => {
        expect(meta('exports')).toEqual(EXPECTED_PROVIDERS);
    });

    it('imports the two processor modules (Activity log + Facades) beside the entity features', () => {
        const imports = meta('imports');
        expect(imports).toContain(ActivityLogModule);
        expect(imports).toContain(FacadesModule);
        // Three forFeature() calls now: the ingest entities, Work (read by
        // the workId-routing resolver), and the external-issue-link pair
        // (ExternalIssueLink + Task). All render as TypeOrmFeatureStub.
        expect(imports).toHaveLength(5);
    });
});

describe('ingest barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, services and repositories', () => {
        expect(barrel.EventIngestModule).toBe(EventIngestModule);
        expect(barrel.EventIngestService).toBe(EventIngestService);
        expect(barrel.IngestedEventRepository).toBe(IngestedEventRepository);
        expect(barrel.EventSourcePullService).toBe(EventSourcePullService);
        expect(barrel.IngestCursorRepository).toBe(IngestCursorRepository);
        expect(barrel.IngestInstallBindingRepository).toBe(IngestInstallBindingRepository);
        expect(barrel.IngestSalienceService).toBe(IngestSalienceService);
        expect(barrel.ExternalIssueLinkRepository).toBe(ExternalIssueLinkRepository);
        expect(barrel.ExternalIssueLinkService).toBe(ExternalIssueLinkService);
        expect(typeof barrel.buildIngestEventTools).toBe('function');
    });
});
