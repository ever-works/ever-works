import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { GitModule } from '../git/git.module';

@Module({
    imports: [AiEngineModule, GitModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
