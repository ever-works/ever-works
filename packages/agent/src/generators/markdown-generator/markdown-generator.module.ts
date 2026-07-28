import { Module } from '@nestjs/common';
import { MarkdownGeneratorService } from './markdown-generator.service';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { FacadesModule } from '../../facades/facades.module';
import { DatabaseModule } from '../../database';
import { WorkOperationsModule } from '@src/work-operations';
import { PolicyModule } from '../../policy/policy.module';

/**
 * `PolicyModule` is imported for `PullRequestGateService` (audit W3 M3):
 * the markdown sync opens a pull request against the published main repo
 * and must consult the Work's quality gate before it does.
 */
@Module({
    imports: [
        DataGeneratorModule,
        FacadesModule,
        DatabaseModule,
        WorkOperationsModule,
        PolicyModule,
    ],
    providers: [MarkdownGeneratorService],
    exports: [MarkdownGeneratorService],
})
export class MarkdownGeneratorModule {}
