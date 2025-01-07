import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { GithubModule } from '../github/github.module';

@Module({
    imports: [AiEngineModule, GithubModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
