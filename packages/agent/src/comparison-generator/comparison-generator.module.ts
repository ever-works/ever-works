import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { WorkOwnershipService } from '../services/work-ownership.service';
import { ComparisonGenerationService } from './comparison-generation.service';

/**
 * Security: `WorkOwnershipService` is provided locally so
 * `ComparisonGenerationService` can run a defense-in-depth, membership-aware
 * authorization gate (creator OR work_members role) on every public method,
 * mirroring `KnowledgeBaseModule`. It only depends on `WorkRepository` +
 * `WorkMemberRepository`, both already exported by the imported
 * `DatabaseModule`, so no new module import is required.
 */
@Module({
    imports: [DatabaseModule, FacadesModule],
    providers: [ComparisonGenerationService, WorkOwnershipService],
    exports: [ComparisonGenerationService],
})
export class ComparisonGeneratorModule {}
