import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { FacadesModule } from '../../facades/facades.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { DatabaseModule } from '@src/database';
import { DirectoryOperationsModule } from '@src/directory-operations';

@Module({
    imports: [FacadesModule, PipelineModule, DatabaseModule, DirectoryOperationsModule],
    providers: [DataGeneratorService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
