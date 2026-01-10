import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { GitModule } from '../git/git.module';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { MarkdownGeneratorModule } from '../markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';
import { ImportExecutorService } from './import-executor.service';

@Module({
    imports: [
        AiModule,
        GitModule,
        DataGeneratorModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
    ],
    providers: [SourceRepoAnalyzerService, AwesomeReadmeParserService, ImportExecutorService],
    exports: [SourceRepoAnalyzerService, AwesomeReadmeParserService, ImportExecutorService],
})
export class ImportModule {}
