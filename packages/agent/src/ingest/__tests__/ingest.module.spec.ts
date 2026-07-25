/**
 * Event-ingest spine (Wave 6) — module-shape pin for EventIngestModule.
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

import 'reflect-metadata';
import { EventIngestModule } from '../ingest.module';
import { IngestedEventRepository } from '../ingested-event.repository';
import { EventIngestService } from '../event-ingest.service';
import { ActivityLogModule } from '../../activity-log/activity-log.module';
import { FacadesModule } from '../../facades/facades.module';

describe('EventIngestModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, EventIngestModule) ?? [];

    it('provides the repository and the ingest service', () => {
        expect(meta('providers')).toEqual([IngestedEventRepository, EventIngestService]);
    });

    it('exports both for the API surface + trigger-internal RPC wiring', () => {
        expect(meta('exports')).toEqual([IngestedEventRepository, EventIngestService]);
    });

    it('imports the two processor modules (Activity log + Facades) beside the entity feature', () => {
        const imports = meta('imports');
        expect(imports).toContain(ActivityLogModule);
        expect(imports).toContain(FacadesModule);
        expect(imports).toHaveLength(3);
    });
});

describe('ingest barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service and repository', () => {
        expect(barrel.EventIngestModule).toBe(EventIngestModule);
        expect(barrel.EventIngestService).toBe(EventIngestService);
        expect(barrel.IngestedEventRepository).toBe(IngestedEventRepository);
        expect(typeof barrel.buildIngestEventTools).toBe('function');
    });
});
