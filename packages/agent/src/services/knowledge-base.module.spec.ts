/**
 * EW-639 Phase 2/e (post-cascade fix) — DI smoke test for KnowledgeBaseModule.
 *
 * `KnowledgeBaseService` injects `@Optional()` references to several
 * services owned by sibling modules (notably `ActivityLogService`). When
 * an owning module isn't imported here, those `@Optional()` resolutions
 * silently land as `undefined` and the affected code paths short-circuit
 * — the API still boots, but features like the upload activity-log
 * sequence stop emitting rows.
 *
 * This spec pins the module's *static* metadata (the decorator's
 * `imports` array). A future cleanup that removes one of these imports
 * trips the assertion immediately rather than failing 30s later in an
 * e2e poll loop.
 *
 * Pattern mirrors `pipeline.module.spec.ts` (row 33c) — the heavy
 * runtime trees (TypeORM, plugin services that import ESM-only
 * `p-map`, etc.) are mocked out at module scope so
 * `Reflect.getMetadata('imports', KnowledgeBaseModule)` returns the
 * real array without forcing those trees to load under Jest's CJS
 * transformer.
 */

jest.mock('@nestjs/typeorm', () => ({
    TypeOrmModule: { forFeature: () => class TypeOrmFeatureStub {} },
    InjectRepository: () => () => undefined,
    InjectDataSource: () => () => undefined,
}));
jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../activity-log/activity-log.module', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));

// Provider classes — replace with empty shells so the metadata still
// records the right class identities without dragging in the full
// implementations (most of which import TypeORM `@InjectRepository` etc.).
jest.mock('../database/repositories/work-knowledge-document.repository', () => ({
    WorkKnowledgeDocumentRepository: class {},
}));
jest.mock('../database/repositories/work-knowledge-upload.repository', () => ({
    WorkKnowledgeUploadRepository: class {},
}));
jest.mock('../database/repositories/work-knowledge-tag.repository', () => ({
    WorkKnowledgeTagRepository: class {},
}));
jest.mock('../database/repositories/work-knowledge-citation.repository', () => ({
    WorkKnowledgeCitationRepository: class {},
}));
jest.mock('../database/repositories/work-knowledge-chunk.repository', () => ({
    WorkKnowledgeChunkRepository: class {},
}));
jest.mock('./knowledge-base.service', () => ({ KnowledgeBaseService: class {} }));
jest.mock('./knowledge-base-git-mirror.service', () => ({
    KnowledgeBaseGitMirrorService: class {},
}));
jest.mock('./knowledge-base-buffer-extractor.service', () => ({
    KnowledgeBaseBufferExtractorService: class {},
}));
jest.mock('./kb-mention-resolver.service', () => ({ KbMentionResolverService: class {} }));
jest.mock('./kb-agent-tools.service', () => ({ KbAgentToolsService: class {} }));
jest.mock('./kb-tools-facade.adapter', () => ({ KbToolsFacadeAdapter: class {} }));
jest.mock('./work-ownership.service', () => ({ WorkOwnershipService: class {} }));

import 'reflect-metadata';
import { KnowledgeBaseModule } from './knowledge-base.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';

describe('KnowledgeBaseModule — static metadata', () => {
    const imports = Reflect.getMetadata('imports', KnowledgeBaseModule) as unknown[];

    it('declares its expected non-TypeORM imports', () => {
        // The TypeORM forFeature import is a dynamic shell from the
        // jest.mock above — we only assert the named module imports
        // here. The static module imports are what the @Module
        // decorator records and what determines DI scope.
        expect(imports).toContain(DatabaseModule);
        expect(imports).toContain(FacadesModule);
        expect(imports).toContain(ActivityLogModule);
    });

    it('imports ActivityLogModule so KnowledgeBaseService.activityLog actually resolves at runtime', () => {
        // EW-639 regression guard. Removing this import doesn't break
        // API boot — it makes every `recordUploadActivity` call early-
        // return because `@Optional() activityLog` lands as undefined.
        // The 3 KB e2e specs (kb-activity-log, kb-dedup, kb-extraction-
        // retry) that poll the activity-log endpoint for KB rows time
        // out after 30s. Lock this import in.
        expect(imports).toContain(ActivityLogModule);
    });
});
