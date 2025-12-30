import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { AwesomeReadmeParserService } from './awesome-readme-parser.service';

@Module({
    imports: [AiModule],
    providers: [SourceRepoAnalyzerService, AwesomeReadmeParserService],
    exports: [SourceRepoAnalyzerService, AwesomeReadmeParserService],
})
export class ImportModule {}
