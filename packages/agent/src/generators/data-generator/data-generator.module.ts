import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { GitModule } from '../../git/git.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { DatabaseModule } from '@src/database';
import { DirectoryOperationsModule } from '@src/directory-operations';

@Module({
    imports: [GitModule, PipelineModule, DatabaseModule, DirectoryOperationsModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
