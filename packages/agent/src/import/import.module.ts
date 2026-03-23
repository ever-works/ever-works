import { Module } from '@nestjs/common';
import { FacadesModule } from '../facades/facades.module';
import { DataGeneratorModule } from '../generators/data-generator/data-generator.module';
import { MarkdownGeneratorModule } from '../generators/markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';
import { ImportExecutorService } from './import-executor.service';
import { ImportEnrichmentService } from './import-enrichment.service';
import { GitIssuePrParserService } from './git-issue-pr-parser.service';

@Module({
    imports: [
        FacadesModule,
        DataGeneratorModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        PipelineModule,
    ],
    providers: [
        SourceRepoAnalyzerService,
        AwesomeReadmeParserService,
        ImportExecutorService,
        ImportEnrichmentService,
        GitIssuePrParserService,
    ],
    exports: [
        SourceRepoAnalyzerService,
        AwesomeReadmeParserService,
        ImportExecutorService,
        ImportEnrichmentService,
        GitIssuePrParserService,
    ],
})
export class ImportModule {}
