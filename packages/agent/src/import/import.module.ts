import { Module } from '@nestjs/common';
import { FacadesModule } from '../facades/facades.module';
import { DataGeneratorModule } from '../generators/data-generator/data-generator.module';
import { MarkdownGeneratorModule } from '../generators/markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { ImportExecutorService } from './import-executor.service';
import { WorksConfigService } from './works-config.service';

@Module({
    imports: [FacadesModule, DataGeneratorModule, MarkdownGeneratorModule, WebsiteGeneratorModule],
    providers: [SourceRepoAnalyzerService, ImportExecutorService, WorksConfigService],
    exports: [SourceRepoAnalyzerService, ImportExecutorService, WorksConfigService],
})
export class ImportModule {}
