/**
 * Meetings v1 (Wave 8, feature a) — module-shape pin for
 * MeetingsModule.
 *
 * Pattern mirrors `ingest.module.spec.ts`: heavy runtime trees
 * (TypeORM, the ingest/facades graphs) are mocked at module scope so
 * the decorator metadata can be asserted without loading them under
 * Jest's CJS transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../../entities/meeting.entity', () => ({
    Meeting: class Meeting {},
}));
jest.mock('../../ingest/ingest.module', () => ({
    EventIngestModule: class EventIngestModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../meeting.repository', () => ({
    MeetingRepository: class MeetingRepository {},
    computeMeetingDedupeKey: jest.fn(() => 'stub'),
}));
jest.mock('../meetings.service', () => ({
    MeetingsService: class MeetingsService {},
}));

import 'reflect-metadata';
import { MeetingsModule } from '../meetings.module';
import { MeetingRepository } from '../meeting.repository';
import { MeetingsService } from '../meetings.service';
import { EventIngestModule } from '../../ingest/ingest.module';
import { FacadesModule } from '../../facades/facades.module';

describe('MeetingsModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, MeetingsModule) ?? [];

    it('provides the repository and the service', () => {
        expect(meta('providers')).toEqual([MeetingRepository, MeetingsService]);
    });

    it('exports both for the API surface + chat-tool assembly', () => {
        expect(meta('exports')).toEqual([MeetingRepository, MeetingsService]);
    });

    it('imports the ingest spine + facades beside the entity feature', () => {
        const imports = meta('imports');
        expect(imports).toContain(EventIngestModule);
        expect(imports).toContain(FacadesModule);
        expect(imports).toHaveLength(3);
    });
});

describe('meetings barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service, repository and tool factory', () => {
        expect(barrel.MeetingsModule).toBe(MeetingsModule);
        expect(barrel.MeetingsService).toBe(MeetingsService);
        expect(barrel.MeetingRepository).toBe(MeetingRepository);
        expect(typeof barrel.buildMeetingTools).toBe('function');
        expect(typeof barrel.computeMeetingDedupeKey).toBe('function');
    });
});
