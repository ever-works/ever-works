/**
 * Digest briefings (Wave 7) — module-shape pin for DigestModule.
 *
 * Pattern mirrors `ingest/__tests__/ingest.module.spec.ts`: the heavy
 * runtime trees (TypeORM, the tasks/agents/goals graphs) are mocked at
 * module scope so the decorator metadata can be asserted without
 * loading them under Jest's CJS transformer.
 */

jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../tasks-domain/tasks.module', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));
jest.mock('../../agents/agents.module', () => ({
    AgentsModule: class AgentsModule {},
}));
jest.mock('../../ingest/ingest.module', () => ({
    EventIngestModule: class EventIngestModule {},
}));
jest.mock('../../goals/goals.module', () => ({
    GoalsModule: class GoalsModule {},
}));
jest.mock('../../notifications/notifications.module', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../digest.service', () => ({
    DigestService: class DigestService {},
}));

import 'reflect-metadata';
import { DigestModule } from '../digest.module';
import { DigestService } from '../digest.service';
import { DatabaseModule } from '../../database/database.module';
import { TasksDomainModule } from '../../tasks-domain/tasks.module';
import { AgentsModule } from '../../agents/agents.module';
import { EventIngestModule } from '../../ingest/ingest.module';
import { GoalsModule } from '../../goals/goals.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { FacadesModule } from '../../facades/facades.module';

describe('DigestModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, DigestModule) ?? [];

    it('provides and exports the digest service for the trigger-internal RPC wiring', () => {
        expect(meta('providers')).toEqual([DigestService]);
        expect(meta('exports')).toEqual([DigestService]);
    });

    it('imports the repository/producer modules the composer reads from', () => {
        expect(meta('imports')).toEqual([
            DatabaseModule,
            TasksDomainModule,
            AgentsModule,
            EventIngestModule,
            GoalsModule,
            NotificationsModule,
            FacadesModule,
        ]);
    });

    it('reaches the model ONLY through FacadesModule (no provider module imported)', () => {
        // The narrative summary must ride `AiFacadeService` so provider
        // resolution, the settings hierarchy, budget guards and usage
        // metering all apply. Importing a provider plugin module here
        // would be a raw-provider back door.
        expect(meta('imports')).toContain(FacadesModule);
    });
});

describe('digest barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service, types and the chat-tool factory', () => {
        expect(barrel.DigestModule).toBe(DigestModule);
        expect(barrel.DigestService).toBe(DigestService);
        expect(typeof barrel.buildDigestTools).toBe('function');
        expect(barrel.DIGEST_PERIODS).toEqual(['daily', 'weekly']);
        expect(barrel.DIGEST_FREQUENCIES).toEqual(['off', 'daily', 'weekly']);
        expect(barrel.DIGEST_SCOPES).toEqual(['personal', 'organization']);
    });
});
