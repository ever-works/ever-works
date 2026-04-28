import { Module } from '@nestjs/common';
import { DataGeneratorService } from './data-generator.service';
import { FacadesModule } from '../../facades/facades.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { DatabaseModule } from '@src/database';
import { DirectoryOperationsModule } from '@src/directory-operations';
import { WorksConfigService, WorksConfigWriterService } from '@src/works-config';

@Module({
    imports: [FacadesModule, PipelineModule, DatabaseModule, DirectoryOperationsModule],
    providers: [DataGeneratorService, WorksConfigService, WorksConfigWriterService],
    exports: [DataGeneratorService],
})
export class DataGeneratorModule {}
