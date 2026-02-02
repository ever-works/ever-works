import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FacadesModule } from '../facades/facades.module';
import { DataGeneratorModule } from '../generators/data-generator/data-generator.module';
import { MarkdownGeneratorModule } from '../generators/markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';
import { ImportExecutorService } from './import-executor.service';

@Module({
    imports: [
        AiModule,
        FacadesModule,
        DataGeneratorModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
    ],
    providers: [SourceRepoAnalyzerService, AwesomeReadmeParserService, ImportExecutorService],
    exports: [SourceRepoAnalyzerService, AwesomeReadmeParserService, ImportExecutorService],
})
export class ImportModule {}
