/**
 * GitHub PR review loop (Wave 7) — module-shape pin for PrReviewModule.
 *
 * Pattern mirrors `ingest/__tests__/ingest.module.spec.ts`: heavy
 * runtime trees are mocked at module scope so the decorator metadata
 * can be asserted without loading them under Jest's CJS transformer.
 */

jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../../ingest/ingest.module', () => ({
    EventIngestModule: class EventIngestModule {},
}));
jest.mock('../../services/knowledge-base.module', () => ({
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));
jest.mock('../pr-review.service', () => ({
    PrReviewService: class PrReviewService {},
}));

import 'reflect-metadata';
import { PrReviewModule } from '../pr-review.module';
import { PrReviewService } from '../pr-review.service';
import { DatabaseModule } from '../../database/database.module';
import { FacadesModule } from '../../facades/facades.module';
import { EventIngestModule } from '../../ingest/ingest.module';
import { KnowledgeBaseModule } from '../../services/knowledge-base.module';

describe('PrReviewModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, PrReviewModule) ?? [];

    it('provides and exports the reviewer service', () => {
        expect(meta('providers')).toEqual([PrReviewService]);
        expect(meta('exports')).toEqual([PrReviewService]);
    });

    it('imports the four dependency modules (DB, facades, ingest spine, KB)', () => {
        const imports = meta('imports');
        expect(imports).toContain(DatabaseModule);
        expect(imports).toContain(FacadesModule);
        expect(imports).toContain(EventIngestModule);
        expect(imports).toContain(KnowledgeBaseModule);
        expect(imports).toHaveLength(4);
    });
});

describe('pr-review barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module, service, types and the chat-tool factory', () => {
        expect(barrel.PrReviewModule).toBe(PrReviewModule);
        expect(barrel.PrReviewService).toBe(PrReviewService);
        expect(typeof barrel.buildPrReviewTools).toBe('function');
        expect(barrel.PR_REVIEW_MAX_COMMENTS).toBe(12);
    });
});
