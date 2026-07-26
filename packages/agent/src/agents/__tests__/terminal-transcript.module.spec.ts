/**
 * Streaming-terminal M9 / founder decision D1 — module-shape pin for
 * TerminalTranscriptModule.
 *
 * Two things this pin exists to catch:
 *
 *  1. A provider silently dropped — the transcript service resolves
 *     `EntitlementsService` (the retention lever) and would otherwise
 *     fail at DI time, in production, on the first publish.
 *  2. `SubscriptionsModule` creeping back into `imports`. This module is
 *     re-exported through the `@ever-works/agent/agents` barrel, and
 *     importing SubscriptionsModule drags NotificationsModule → auth →
 *     services → generators into every consumer of that barrel — which
 *     breaks apps/api's jest module mapping outright. `EntitlementsService`
 *     is provided directly instead; its only dependency
 *     (`PlanEntitlementRepository`) comes from DatabaseModule.
 *
 * Pattern mirrors `fleet.module.spec.ts`: heavy runtime trees are mocked
 * at module scope so the decorator metadata can be asserted without
 * loading them under Jest's CJS transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../../entities/agent-run.entity', () => ({ AgentRun: class AgentRun {} }));
jest.mock('../../entities/terminal-transcript-chunk.entity', () => ({
    TerminalTranscriptChunk: class TerminalTranscriptChunk {},
}));
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../database/repositories/agent-run.repository', () => ({
    AgentRunRepository: class AgentRunRepository {},
}));
jest.mock('../../database/repositories/terminal-transcript-chunk.repository', () => ({
    TerminalTranscriptChunkRepository: class TerminalTranscriptChunkRepository {},
}));
jest.mock('../../subscriptions/credits/entitlements.service', () => ({
    EntitlementsService: class EntitlementsService {},
}));
jest.mock('../terminal-transcript.service', () => ({
    TerminalTranscriptService: class TerminalTranscriptService {},
}));

import 'reflect-metadata';
import { TerminalTranscriptModule } from '../terminal-transcript.module';
import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import { TerminalTranscriptChunkRepository } from '../../database/repositories/terminal-transcript-chunk.repository';
import { EntitlementsService } from '../../subscriptions/credits/entitlements.service';
import { TerminalTranscriptService } from '../terminal-transcript.service';
import { DatabaseModule } from '../../database/database.module';

describe('TerminalTranscriptModule', () => {
    const meta = (key: string): unknown[] =>
        (Reflect.getMetadata(key, TerminalTranscriptModule) as unknown[]) ?? [];

    it('provides the chunk repository, the run repository, entitlements and the service', () => {
        expect(meta('providers')).toEqual([
            TerminalTranscriptChunkRepository,
            AgentRunRepository,
            EntitlementsService,
            TerminalTranscriptService,
        ]);
    });

    it('exports the service (publish + replay + sweep) and the repository', () => {
        expect(meta('exports')).toEqual([
            TerminalTranscriptService,
            TerminalTranscriptChunkRepository,
        ]);
    });

    it('imports ONLY DatabaseModule + the entity feature — never SubscriptionsModule', () => {
        const imports = meta('imports');
        expect(imports).toHaveLength(2);
        expect(imports[0]).toBe(DatabaseModule);
        expect(imports.map((m) => (m as { name?: string })?.name)).not.toContain(
            'SubscriptionsModule',
        );
    });
});
